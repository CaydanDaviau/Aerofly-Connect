package com.aeroflyconnect.app;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;

/** In-memory radio log for the overlay: ATC calls heard and what the pilot said. Cleared at every Start. */
final class RadioLog {
    static final class Entry {
        final boolean pilot;
        final String who, text, time;
        Entry(boolean pilot, String who, String text, String time) { this.pilot = pilot; this.who = who; this.text = text; this.time = time; }
    }

    private static final int MAX = 40;
    private static final ArrayList<Entry> list = new ArrayList<>();
    private static volatile int version;

    static synchronized void clear() { list.clear(); version++; }

    static synchronized void add(boolean pilot, String who, String text) {
        if (text == null || text.trim().isEmpty()) return;
        Calendar c = Calendar.getInstance();
        String t = String.format(java.util.Locale.US, "%02d:%02d", c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));
        list.add(new Entry(pilot, who, text.trim(), t));
        while (list.size() > MAX) list.remove(0);
        version++;
    }

    static int version() { return version; }

    static synchronized List<Entry> snapshot() { return new ArrayList<>(list); }

    /** Text of the last ATC call, or "". */
    static synchronized String lastAtc() {
        for (int i = list.size() - 1; i >= 0; i--) if (!list.get(i).pilot) return list.get(i).text;
        return "";
    }

    /** Who ATC is, from the controller contact ("Ground 121.900" -> "Ground"), else "ATC". */
    static String atcName(String contact) {
        if (contact == null) return "ATC";
        String c = contact.trim();
        int sp = c.indexOf(' ');
        if (sp > 0) c = c.substring(0, sp);
        return c.isEmpty() ? "ATC" : c;
    }

    /** What the pilot says when asking for something. */
    static String callFor(boolean pt, String type, String alt, String callsign, boolean air, String contact) {
        String cs = callsign == null || callsign.isEmpty() ? (pt ? "Aeronave" : "Aircraft") : callsign;
        String to = atcName(contact);
        if (to.equals("ATC")) {
            if (type.equals("takeoff") || type.equals("land")) to = pt ? "Torre" : "Tower";
            else if (type.equals("climb") || type.equals("descent")) to = pt ? "Controle" : "Approach";
            else to = pt ? "Solo" : "Ground";
        }
        String what;
        switch (type) {
            case "clearance": what = pt ? "solicito partida e autorização" : "request start-up and clearance"; break;
            case "pushback": what = pt ? "solicito pushback" : "request pushback"; break;
            case "taxi": what = pt ? "solicito táxi" : "request taxi"; break;
            case "takeoff": what = pt ? "pronto para decolagem" : "ready for departure"; break;
            case "land": what = pt ? "solicito pouso" : "request landing"; break;
            case "climb": what = (pt ? "solicito subida para " : "request climb to ") + altSay(alt); break;
            case "descent": what = (pt ? "solicito descida para " : "request descent to ") + altSay(alt); break;
            case "mayday": return "MAYDAY MAYDAY MAYDAY, " + cs;
            case "mayday_cancel": return (pt ? "Cancelo a emergência, " : "Cancel mayday, ") + cs;
            default: what = type;
        }
        return to + ", " + cs + ", " + what + ".";
    }

    private static String altSay(String a) {
        if (a == null) return "";
        String t = a.trim().toUpperCase(java.util.Locale.ROOT);
        if (t.startsWith("FL")) return t;
        try {
            int n = Integer.parseInt(t);
            return n < 1000 ? "FL" + n : n + " ft";
        } catch (Exception e) { return t; }
    }

    /** Readback text for an ATC instruction: the instruction followed by the callsign. */
    static String readback(boolean pt, boolean instruction, String atcText, String callsign) {
        String cs = callsign == null ? "" : callsign;
        if (!instruction) return (pt ? "Ciente" : "Roger") + (cs.isEmpty() ? "" : ", " + cs) + ".";
        String t = atcText.trim();
        if (t.endsWith(".")) t = t.substring(0, t.length() - 1);
        return t + (cs.isEmpty() ? "" : ", " + cs) + ".";
    }
}
