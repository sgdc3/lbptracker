import cwlib.enums.Part;
import cwlib.resources.RPlan;
import cwlib.structs.things.Thing;
import cwlib.structs.things.parts.PInstrument;
import cwlib.types.SerializedResource;
import cwlib.types.archives.Fart;
import cwlib.types.archives.FileArchive;
import cwlib.types.data.SHA1;
import cwlib.types.databases.FileDB;
import cwlib.types.databases.FileDBRow;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * The factory settings every sequencer instrument ships with -- above all the
 * colour of its chip.
 *
 *   InstrumentColours <orbisguids.map> <gamedir>
 *
 * A chip is placed from the instrument's own popit plan, so that plan holds
 * what the game gives a chip nobody has touched: `PInstrument.Colour` and the
 * mixer defaults. It also holds the two fields `chips.ts` tabulates -- the
 * plan's own GUID is the Thing's `planGuid`, and `PInstrument.Icon` is the
 * picture on the chip -- so the same run re-measures those against the corpus
 * tally `dev/chip-table.ts` produced.
 *
 * Columns: instrument GUID, colour, plan GUID, chip icon, inventory icon, the
 * mixer defaults, the path.
 *
 * ⚠️ cwlib is used rather than `packages/cwlib-ts`, because these plans are
 * revision 0x397 and our own reader deliberately stops at 0x3b7.
 *
 * Build and run (JDK 21+, NOT the 1.8 on PATH -- see steering/tools.md):
 *   javac -cp "$JAR" -d out tools/InstrumentColours.java
 *   java -cp "$JAR;out" InstrumentColours \
 *     D:/PS4Games/CUSA00063/output/orbisguids.map D:/PS4Games/CUSA00063
 */
public class InstrumentColours {
    public static void main(String[] a) throws Exception {
        FileDB db = new FileDB(a[0]);
        List<Fart> archives = new ArrayList<>();
        for (File f : new File(a[1]).listFiles((d, n) -> n.toLowerCase().endsWith(".farc")))
            try { archives.add(new FileArchive(f)); } catch (Throwable ignored) { }

        int found = 0, failed = 0;
        for (FileDBRow row : db) {
            String path = row.getPath();
            if (path == null || !path.contains("instrument_") || !path.endsWith(".plan")) continue;
            byte[] planBytes = null;
            SHA1 sha1 = row.getSHA1();
            for (Fart f : archives) if (sha1 != null && f.exists(sha1)) { planBytes = f.extract(sha1); break; }
            if (planBytes == null) continue;
            RPlan resource;
            Thing[] things;
            try {
                resource = new SerializedResource(planBytes).loadResource(RPlan.class);
                things = resource.getThings();
            } catch (Throwable t) { failed++; continue; }
            long planGuid = row.getGUID() == null ? 0 : row.getGUID().getValue();
            long inventoryIcon =
                resource.inventoryData == null || resource.inventoryData.icon == null
                    || resource.inventoryData.icon.getGUID() == null
                ? 0 : resource.inventoryData.icon.getGUID().getValue();
            for (Thing thing : things) {
                if (thing == null) continue;
                PInstrument inst = thing.getPart(Part.INSTRUMENT);
                if (inst == null) continue;
                long guid = inst.instrument == null || inst.instrument.getGUID() == null
                    ? 0 : inst.instrument.getGUID().getValue();
                long icon = inst.icon == null || inst.icon.getGUID() == null
                    ? 0 : inst.icon.getGUID().getValue();
                System.out.printf(
                    "%d\t0x%08x\t%d\t%d\t%d\tlevel=%s pan=%s echo=%s reverb=%s key=%d scale=%d loops=%d notes=%d name=\"%s\"\t%s%n",
                    guid, inst.color, planGuid, icon, inventoryIcon,
                    inst.level, inst.pan, inst.echoSend, inst.reverbSend,
                    inst.key, inst.scale, inst.loops,
                    inst.notes == null ? 0 : inst.notes.size(),
                    inst.name == null ? "" : inst.name, path);
                found++;
            }
        }
        System.err.printf("%d instrument chips, %d plans that would not load%n", found, failed);
    }
}
