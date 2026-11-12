import afconnect as a
l = a.UdpLink()
l.handle("XGPSAerofly,-47.9,-15.87,1000,279,100", 10.0)
l.handle("XGPSAerofly,-47.9,-15.87,1100,279,100", 11.0)
l.handle("XATTAerofly,281,2,0", 11.0)
p = l.position(11.5)
assert p["heading_true"] == 281 and p["ground_speed"] == round(100*1.943844) and p["altitude_ft"] == round(1100*3.28084), p
assert p["vertical_speed_ft_min"] > 0
assert l.position(20) is None
l.handle("garbage"); l.handle("XGPS,1,2")
print("PASS", p)
