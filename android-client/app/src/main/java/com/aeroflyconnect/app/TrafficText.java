package com.aeroflyconnect.app;

/** Wording of a traffic advisory (TA). Spoken text uses words only (no digits), so the radio voice does not spell numbers out. */
final class TrafficText {
    private TrafficText() {}

    private static final String[] EN_N = {"", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"};
    private static final String[] PT_N = {"", "uma", "duas", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze"};
    private static final String[] PT_H = {"", "cem", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"};

    private static int round100(int ft) { return Math.abs(Math.round(ft / 100f)) * 100; }

    private static String feetEn(int ft) {
        int th = ft / 1000, h = (ft % 1000) / 100;
        StringBuilder sb = new StringBuilder();
        if (th > 0) sb.append(EN_N[th]).append(" thousand");
        if (h > 0) sb.append(sb.length() > 0 ? " " : "").append(EN_N[h]).append(" hundred");
        return sb.toString();
    }

    private static String feetPt(int ft) {
        int th = ft / 1000, h = (ft % 1000) / 100;
        if (th > 0) return "mil" + (h > 0 ? " e " + PT_H[h] : "");
        return PT_H[h];
    }

    /** Text for the voice: "Traffic, traffic. Two o'clock, three hundred feet above, descending." */
    static String speech(boolean pt, int clock, int dz, int trend) {
        int c = Math.max(1, Math.min(12, clock)), ft = round100(dz);
        StringBuilder sb = new StringBuilder();
        if (pt) {
            sb.append("Tráfego, tráfego. ").append(c == 1 ? "À uma hora" : "Às " + PT_N[c] + " horas");
            if (ft >= 100) sb.append(", ").append(feetPt(ft)).append(" pés ").append(dz > 0 ? "acima" : "abaixo");
            else sb.append(", na mesma altitude");
            if (trend > 0) sb.append(", subindo"); else if (trend < 0) sb.append(", descendo");
        } else {
            sb.append("Traffic, traffic. ").append(c == 12 ? "Twelve" : cap(EN_N[c])).append(" o'clock");
            if (ft >= 100) sb.append(", ").append(feetEn(ft)).append(" feet ").append(dz > 0 ? "above" : "below");
            else sb.append(", same altitude");
            if (trend > 0) sb.append(", climbing"); else if (trend < 0) sb.append(", descending");
        }
        return sb.append('.').toString();
    }

    /** Short text for the overlay / notification: "TRAFFIC  2 o'clock · 300 ft above · descending". */
    static String shown(boolean pt, int clock, int dz, int trend) {
        int c = Math.max(1, Math.min(12, clock)), ft = round100(dz);
        StringBuilder sb = new StringBuilder(pt ? "TRÁFEGO  " : "TRAFFIC  ");
        sb.append(c).append(pt ? " horas" : " o'clock");
        if (ft >= 100) sb.append(" · ").append(ft).append(pt ? " pés " : " ft ").append(dz > 0 ? (pt ? "acima" : "above") : (pt ? "abaixo" : "below"));
        else sb.append(" · ").append(pt ? "mesma altitude" : "same altitude");
        if (trend > 0) sb.append(" · ").append(pt ? "subindo" : "climbing");
        else if (trend < 0) sb.append(" · ").append(pt ? "descendo" : "descending");
        return sb.toString();
    }

    private static String cap(String s) { return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1); }
}
