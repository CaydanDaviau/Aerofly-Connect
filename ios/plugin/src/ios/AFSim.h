#import <Cordova/CDV.h>
#import <AVFoundation/AVFoundation.h>
@interface AFSim : CDVPlugin
- (void)tcpRead:(CDVInvokedUrlCommand *)c;
- (void)tcpClose:(CDVInvokedUrlCommand *)c;
- (void)http:(CDVInvokedUrlCommand *)c;
- (void)keepAlive:(CDVInvokedUrlCommand *)c;
@end
