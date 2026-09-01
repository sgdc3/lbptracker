import cwlib.enums.Part;
import cwlib.io.Resource;
import cwlib.resources.RLevel;
import cwlib.resources.RPlan;
import cwlib.structs.things.Thing;
import cwlib.structs.things.parts.PWorld;
import cwlib.types.SerializedResource;
import cwlib.types.data.WrappedResource;

import java.io.File;
import java.util.*;

/**
 * How many distinct Thing parts a level corpus actually uses, overall and on
 * the Things a tracker cares about.
 *
 * The Thing stream has no length prefixes and references are inline ids, so a
 * TypeScript walk cannot skip anything -- SEQUENCER is 38th of 54 in the part
 * enum. This puts a number on how much of that is real work. The second half
 * matters more than the first: it says which parts share a Thing with a
 * SEQUENCER or an INSTRUMENT, which is the set a targeted parse would need.
 *
 *   javac -cp "$JAR" -d out tools/PartCensus.java
 *   java  -cp "$JAR;out" PartCensus <dir-or-file> [...] 2>/dev/null | grep -v '^\[FileIO\]'
 */
public class PartCensus {
    static Map<String, Integer> tally = new TreeMap<>();
    static Map<String, Integer> withSeq = new TreeMap<>();
    static Map<String, Integer> withIns = new TreeMap<>();
    static Map<String, Integer> seqShapes = new TreeMap<>();
    static Map<String, Integer> insShapes = new TreeMap<>();
    static int things = 0, files = 0, seqThings = 0, insThings = 0;

    public static void main(String[] args) throws Exception {
        for (String p : args) walk(new File(p));
        System.out.println("files " + files + ", things " + things);
        System.out.println("distinct parts used: " + tally.size() + " of " + Part.values().length);
        dump("ALL THINGS", tally, things);
        System.out.println("\nthings carrying a SEQUENCER: " + seqThings);
        dump("  co-occurring", withSeq, seqThings);
        System.out.println("  distinct part-sets seen on them:");
        seqShapes.entrySet().stream().sorted((a,b) -> b.getValue() - a.getValue())
            .forEach(e -> System.out.printf("    %5d  %s%n", e.getValue(), e.getKey()));
        System.out.println("\nthings carrying an INSTRUMENT: " + insThings);
        dump("  co-occurring", withIns, insThings);
        System.out.println("  distinct part-sets seen on them:");
        insShapes.entrySet().stream().sorted((a,b) -> b.getValue() - a.getValue())
            .forEach(e -> System.out.printf("    %5d  %s%n", e.getValue(), e.getKey()));
    }

    static void dump(String label, Map<String,Integer> m, int of) {
        System.out.println(label + " (" + m.size() + " kinds of " + of + "):");
        m.entrySet().stream().sorted((a, b) -> b.getValue() - a.getValue())
            .forEach(e -> System.out.printf("    %-22s %d%n", e.getKey(), e.getValue()));
    }

    static void walk(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) walk(k);
            return;
        }
        if (!f.isFile()) return;
        Resource resource;
        try {
            resource = (Resource) new WrappedResource(new SerializedResource(f.getPath())).resource;
        } catch (Throwable t) { return; }
        List<Thing> list;
        if (resource instanceof RLevel level) {
            PWorld world = level.worldThing.getPart(Part.WORLD);
            if (world == null) return;
            list = world.things;
        } else if (resource instanceof RPlan plan) {
            try { list = List.of(plan.getThings()); } catch (Throwable t) { return; }
        } else return;
        files++;
        for (Thing t : list) {
            if (t == null) continue;
            things++;
            List<String> present = new ArrayList<>();
            for (Part part : Part.values())
                if (t.hasPart(part)) { present.add(part.name()); tally.merge(part.name(), 1, Integer::sum); }
            String shape = String.join("+", present);
            if (t.hasPart(Part.SEQUENCER)) {
                seqThings++;
                for (String s : present) withSeq.merge(s, 1, Integer::sum);
                seqShapes.merge(shape, 1, Integer::sum);
            }
            if (t.hasPart(Part.INSTRUMENT)) {
                insThings++;
                for (String s : present) withIns.merge(s, 1, Integer::sum);
                insShapes.merge(shape, 1, Integer::sum);
            }
        }
    }
}
