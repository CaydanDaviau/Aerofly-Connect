#import "AFSim.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <errno.h>

@implementation AFSim {
  int _fd; NSString *_host; int _port; dispatch_queue_t _q; AVAudioPlayer *_player;
}

- (void)pluginInitialize { _fd = -1; _q = dispatch_queue_create("afsim.tcp", DISPATCH_QUEUE_SERIAL); }

- (void)closeFd { if (_fd >= 0) { close(_fd); _fd = -1; } }

// connect with a timeout; returns fd or -1
- (int)openHost:(NSString *)host port:(int)port ms:(int)ms {
  struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof hints); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
  char ps[16]; snprintf(ps, sizeof ps, "%d", port);
  if (getaddrinfo(host.UTF8String, ps, &hints, &res) != 0 || !res) return -1;
  int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
  if (fd < 0) { freeaddrinfo(res); return -1; }
  int on = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof on); setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
  int r = connect(fd, res->ai_addr, res->ai_addrlen); freeaddrinfo(res);
  if (r != 0) {
    if (errno != EINPROGRESS) { close(fd); return -1; }
    struct pollfd p = { fd, POLLOUT, 0 };
    if (poll(&p, 1, ms) <= 0) { close(fd); return -1; }
    int err = 0; socklen_t l = sizeof err; getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &l);
    if (err) { close(fd); return -1; }
  }
  return fd;
}

// Aerofly's sim link: send "req_gmap_dat\n", answer is one line.
- (void)tcpRead:(CDVInvokedUrlCommand *)c {
  NSString *host = [c.arguments objectAtIndex:0]; int port = [[c.arguments objectAtIndex:1] intValue]; int ms = [[c.arguments objectAtIndex:2] intValue];
  dispatch_async(_q, ^{
    if (self->_fd >= 0 && (![self->_host isEqualToString:host] || self->_port != port)) [self closeFd];
    if (self->_fd < 0) {
      self->_fd = [self openHost:host port:port ms:3000]; self->_host = host; self->_port = port;
      if (self->_fd < 0) { [self fail:c msg:@"connect failed"]; return; }
    }
    const char *cmd = "req_gmap_dat\n";
    if (send(self->_fd, cmd, strlen(cmd), 0) < 0) { [self closeFd]; [self fail:c msg:@"write failed"]; return; }
    NSMutableData *buf = [NSMutableData data]; char ch[512];
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:ms / 1000.0];
    while ([end timeIntervalSinceNow] > 0) {
      struct pollfd p = { self->_fd, POLLIN, 0 };
      if (poll(&p, 1, (int)([end timeIntervalSinceNow] * 1000)) <= 0) break;
      ssize_t n = recv(self->_fd, ch, sizeof ch, 0);
      if (n <= 0) { [self closeFd]; [self fail:c msg:@"closed"]; return; }
      [buf appendBytes:ch length:n];
      const char *b = (const char *)buf.bytes; const void *nl = memchr(b, '\n', buf.length);
      if (nl) {
        NSString *line = [[NSString alloc] initWithBytes:b length:(const char *)nl - b encoding:NSISOLatin1StringEncoding];
        line = [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        [self.commandDelegate sendPluginResult:[CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsString:line] callbackId:c.callbackId]; return;
      }
    }
    [self closeFd]; [self fail:c msg:@"no answer"];
  });
}

- (void)fail:(CDVInvokedUrlCommand *)c msg:(NSString *)m {
  [self.commandDelegate sendPluginResult:[CDVPluginResult resultWithStatus:CDVCommandStatus_ERROR messageAsString:m] callbackId:c.callbackId];
}

- (void)tcpClose:(CDVInvokedUrlCommand *)c {
  dispatch_async(_q, ^{ [self closeFd]; [self.commandDelegate sendPluginResult:[CDVPluginResult resultWithStatus:CDVCommandStatus_OK] callbackId:c.callbackId]; });
}

// HTTP without browser CORS rules (the server and SimBrief send no CORS headers).
- (void)http:(CDVInvokedUrlCommand *)c {
  NSString *method = [c.arguments objectAtIndex:0], *url = [c.arguments objectAtIndex:1]; NSDictionary *hd = [c.arguments objectAtIndex:2];
  NSString *body = [c.arguments objectAtIndex:3]; double ms = [[c.arguments objectAtIndex:4] doubleValue];
  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url] cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:ms / 1000.0];
  r.HTTPMethod = method;
  for (NSString *k in hd) [r setValue:[NSString stringWithFormat:@"%@", hd[k]] forHTTPHeaderField:k];
  if (body.length) r.HTTPBody = [body dataUsingEncoding:NSUTF8StringEncoding];
  [[[NSURLSession sharedSession] dataTaskWithRequest:r completionHandler:^(NSData *d, NSURLResponse *resp, NSError *e) {
    if (e || ![resp isKindOfClass:[NSHTTPURLResponse class]]) { [self fail:c msg:e ? e.localizedDescription : @"no response"]; return; }
    NSString *s = d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : @""; if (!s) s = @"";
    NSDictionary *o = @{ @"status": @(((NSHTTPURLResponse *)resp).statusCode), @"body": s };
    [self.commandDelegate sendPluginResult:[CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsDictionary:o] callbackId:c.callbackId];
  }] resume];
}

// Silent looping audio keeps the app running while Aerofly is in front (UIBackgroundModes audio); mixes with the sim's sound.
- (void)keepAlive:(CDVInvokedUrlCommand *)c {
  BOOL on = [[c.arguments objectAtIndex:0] boolValue];
  if (on && !_player) {
    AVAudioSession *s = [AVAudioSession sharedInstance];
    [s setCategory:AVAudioSessionCategoryPlayback withOptions:AVAudioSessionCategoryOptionMixWithOthers error:nil];
    [s setActive:YES error:nil];
    int rate = 8000, n = rate; NSMutableData *w = [NSMutableData data];
    uint32_t dl = n * 2, rl = 36 + dl, fmtLen = 16, br = rate * 2; uint16_t pcm = 1, ch = 1, ba = 2, bits = 16;
    [w appendBytes:"RIFF" length:4]; [w appendBytes:&rl length:4]; [w appendBytes:"WAVEfmt " length:8]; [w appendBytes:&fmtLen length:4];
    [w appendBytes:&pcm length:2]; [w appendBytes:&ch length:2]; [w appendBytes:&(uint32_t){ (uint32_t)rate } length:4]; [w appendBytes:&br length:4];
    [w appendBytes:&ba length:2]; [w appendBytes:&bits length:2]; [w appendBytes:"data" length:4]; [w appendBytes:&dl length:4];
    [w increaseLengthBy:dl];
    _player = [[AVAudioPlayer alloc] initWithData:w error:nil]; _player.numberOfLoops = -1; _player.volume = 0.0; [_player play];
  } else if (!on && _player) { [_player stop]; _player = nil; [[AVAudioSession sharedInstance] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil]; }
  [self.commandDelegate sendPluginResult:[CDVPluginResult resultWithStatus:CDVCommandStatus_OK] callbackId:c.callbackId];
}
@end
