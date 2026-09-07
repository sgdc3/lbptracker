import cwlib.resources.RPlan;
import cwlib.resources.RTranslationTable;
import cwlib.types.SerializedResource;
import cwlib.types.archives.Fart;
import cwlib.types.archives.FileArchive;
import cwlib.types.data.ResourceDescriptor;
import cwlib.types.data.SHA1;
import cwlib.types.databases.FileDB;
import cwlib.types.databases.FileDBRow;

import java.io.File;
import java.nio.file.*;
import java.util.*;

/**
 * The name the game shows for each sequencer instrument, joined to the `.rinst`
 * GUID this project keys an instrument by.
 *
 * Every `*instrument_*.plan` in the game's archives is a palette item whose
 * `InventoryItemDetails.titleKey` is a LAMS id; the translation table turns
 * that into the words a player reads, and the plan's dependency list names the
 * `.rinst` the item places. Taken together on 2026-09-07 that names all 68
 * files, each by exactly one plan, with no two plans disagreeing -- which is
 * what makes the join sound rather than a lookup by name.
 *
 *   java -cp "$JAR;out" InstrumentNames <orbisguids.map> <gamedir> <english.trans>
 *
 * Prints JSON on stdout (⚠️ with the FileDB's own "[FileIO] Reading file" line
 * before it, which a parser has to drop). `<english.trans>` comes out of the
 * archives first:
 *
 *   java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> out "languages/english.trans"
 *
 * ⚠️ Needs JDK 21 or 25; the `java` on PATH here is 1.8 and dies with
 * UnsupportedClassVersionError. The table it feeds is
 * `packages/lbp-tracker-web/src/editor/instrument-labels.ts`.
 */
public class InstrumentNames {
    public static void main(String[] a) throws Exception {
        FileDB db = new FileDB(a[0]);
        RTranslationTable lams = new RTranslationTable(Files.readAllBytes(Paths.get(a[2])));
        List<Fart> archives = new ArrayList<>();
        File[] farcs = new File(a[1]).listFiles((d, n) -> n.toLowerCase().endsWith(".farc"));
        for (File f : farcs) {
            try { archives.add(new FileArchive(f)); } catch (Throwable t) { }
        }
        System.out.println("[");
        boolean first = true;
        for (FileDBRow row : db) {
            String path = row.getPath();
            if (path == null || !path.contains("instrument_")) continue;
            SHA1 sha1 = row.getSHA1();
            byte[] data = null;
            for (Fart archive : archives) if (archive.exists(sha1)) { data = archive.extract(sha1); break; }
            if (data == null) continue;
            RPlan plan;
            try { plan = new SerializedResource(data).loadResource(RPlan.class); }
            catch (Throwable t) { System.err.println("skip " + path + ": " + t); continue; }
            String title = plan.inventoryData == null ? null : lams.translate(plan.inventoryData.titleKey);
            String desc = plan.inventoryData == null ? null : lams.translate(plan.inventoryData.descriptionKey);
            String tag = plan.inventoryData == null ? null : plan.inventoryData.translationTag;
            // the GUIDs it pulls in: one of them is the .rinst
            List<String> deps = new ArrayList<>();
            if (plan.dependencyCache != null)
                for (ResourceDescriptor d : plan.dependencyCache)
                    if (d != null && d.getGUID() != null) deps.add(d.getGUID().toString().replace("g", ""));
            if (!first) System.out.println(",");
            first = false;
            System.out.printf("  {\"path\": \"%s\", \"tag\": %s, \"title\": %s, \"desc\": %s, \"titleKey\": %d, \"deps\": [%s]}",
                path, quote(tag), quote(title), quote(desc),
                plan.inventoryData == null ? 0 : plan.inventoryData.titleKey,
                String.join(",", deps));
        }
        System.out.println("\n]");
    }
    static String quote(String s) {
        return s == null ? "null" : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }
}
