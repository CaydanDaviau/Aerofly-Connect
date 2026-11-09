package com.aeroflyconnect.app;

/** Address of the device that runs the sim: 127.0.0.1 (same phone) or the Wi-Fi IP of another device. */
final class SimHost {
    static final String LOCAL = "127.0.0.1";

    private SimHost() { }

    static String normalize(String s) {
        s = s == null ? "" : s.trim();
        return s.isEmpty() ? LOCAL : s;
    }

    static boolean isLocal(String h) {
        return LOCAL.equals(h) || "localhost".equalsIgnoreCase(h);
    }

    /** null = fine, "mobile" = carrier-style 192.0.0.x address (not a LAN IP), "invalid" = not an address. */
    static String problem(String s) {
        String h = normalize(s);
        if (h.startsWith("192.0.0.")) return "mobile";
        if (h.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
            for (String p : h.split("\\.")) if (Integer.parseInt(p) > 255) return "invalid";
            return null;
        }
        if (h.matches("[0-9.]+")) return "invalid";   // digits and dots must be a full IPv4 address
        return h.matches("[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?") ? null : "invalid";
    }
}
