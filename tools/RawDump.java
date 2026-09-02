import cwlib.enums.Part;
import cwlib.io.Resource;
import cwlib.resources.RLevel;
import cwlib.resources.RPlan;
import cwlib.structs.instrument.Note;
import cwlib.structs.things.Thing;
import cwlib.structs.things.components.CompactComponent;
import cwlib.structs.things.parts.PInstrument;
import cwlib.structs.things.parts.PMicrochip;
import cwlib.structs.things.parts.PSequencer;
import cwlib.structs.things.parts.PWorld;
import cwlib.types.SerializedResource;
import cwlib.types.data.WrappedResource;
import org.joml.Vector3f;
import toolkit.tools.sequencerdump.utils.PositionUtils;

import java.io.File;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Structural dump of every music sequencer in a level, with the note records
 * emitted as RAW BYTES.
 *
 * Uses only the extraction half of the toolkit -- resource load, Thing graph
 * walk, circuit-board component positions. It deliberately does NOT use any of
 * the musical interpretation (note grouping, durations, triplet timing): those
 * are exactly what we are trying to measure independently.
 *
 * Output is one JSON object per line, per instrument, with the note records as
 * a hex string. Lines the toolkit prints to stdout do not start with '{', so
 * filter with `grep '^{'`.
 *
 * This is the odd one out in tools/: Java, and it needs an external jar. It
 * earns its place because it is what made the note-record statistics in
 * steering/sequencer-data-model.md reproducible. Build and run:
 *
 *   JAR=C:\Users\sgdc3\Desktop\LBP\toolkit\tools\sequencerdump\target\sequencerdump-0.1.jar
 *   javac -cp "$JAR" -d out tools/RawDump.java
 *   java  -cp "$JAR;out" RawDump <level> [<level> ...] | grep '^{' > notes.jsonl
 *
 * ⚠️ Use the JDK 25 `java`, not whatever is first on PATH — a Java 8 runtime is
 * installed on this machine and fails with UnsupportedClassVersionError:
 *   "C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot\bin\java"
 */
public class RawDump {

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ").replace("\t", " ");
    }

    public static void main(String[] args) throws Exception {
        PrintStream out = System.out;
        for (String path : args) {
            File f = new File(path);
            if (!f.isFile()) continue;
            Resource resource;
            try {
                resource = (Resource) new WrappedResource(new SerializedResource(path)).resource;
            } catch (Throwable t) {
                System.err.println("LOAD FAIL " + f.getName() + ": " + t);
                continue;
            }
            try {
                dump(out, f.getName(), resource);
            } catch (Throwable t) {
                System.err.println("WALK FAIL " + f.getName() + ": " + t);
            }
        }
    }

    static void dump(PrintStream out, String file, Resource resource) {
        List<Thing> things;
        if (resource instanceof RLevel level) {
            PWorld world = level.worldThing.getPart(Part.WORLD);
            things = world.things;
        } else if (resource instanceof RPlan plan) {
            things = List.of(plan.getThings());
        } else {
            System.err.println("SKIP " + file + ": " + resource.getClass().getSimpleName());
            return;
        }

        // A world's Thing list can carry the same music sequencer twice, and
        // without this guard the whole sequencer is emitted twice -- instIdx
        // 0..N, then 0..N again, byte for byte. It is not rare: 60 of the 338
        // sequencers in this project's corpus came out doubled, and because
        // every note then costs two of the engine's 32 voices, dense passages
        // lose notes the game keeps. Dedupe by UID, and by identity for the
        // case where UIDs are not unique.
        Set<Integer> seenUid = new HashSet<>();
        Set<Thing> seenThing = new HashSet<>();
        for (Thing thing : things) {
            if (thing == null) continue;
            PMicrochip chip = thing.getPart(Part.MICROCHIP);
            if (chip == null) continue;
            PSequencer seq = thing.getPart(Part.SEQUENCER);
            if (seq == null || !seq.musicSequencer) continue;
            if (!seenThing.add(thing) || !seenUid.add(thing.UID)) {
                System.err.println("DUPLICATE sequencer UID " + thing.UID + " in " + file
                                   + " -- skipping the repeat");
                continue;
            }

            // The open-circuit-board case: Components is unreliable, rebuild it
            // from the Thing graph.
            CompactComponent[] comps = chip.components;
            Thing board = chip.circuitBoardThing;
            if (board != null && board.hasPart(Part.POS)) {
                List<CompactComponent> rebuilt = new ArrayList<>();
                for (Thing child : things) {
                    if (child == null || child.parent == null) continue;
                    if (child.parent.UID != board.UID) continue;
                    if (!child.hasPart(Part.INSTRUMENT)) continue;
                    Vector3f p = PositionUtils.getRelativePosition(board, child);
                    CompactComponent c = new CompactComponent();
                    c.x = p.x; c.y = p.y; c.thing = child;
                    rebuilt.add(c);
                }
                comps = rebuilt.toArray(new CompactComponent[0]);
            }
            if (comps == null) comps = new CompactComponent[0];

            float[] vol = seq.getVolume();
            StringBuilder vols = new StringBuilder();
            for (int i = 0; i < vol.length; ++i) {
                if (i > 0) vols.append(',');
                vols.append(vol[i]);
            }

            int idx = 0;
            for (CompactComponent c : comps) {
                if (c == null || c.thing == null) continue;
                PInstrument ins = c.thing.getPart(Part.INSTRUMENT);
                if (ins == null) continue;

                StringBuilder hex = new StringBuilder();
                for (Note n : ins.notes) {
                    int b0 = (n.x & 0x7f) | (n.triplet ? 0x80 : 0);
                    int b1 = (n.y & 0x7f) | (n.end ? 0x80 : 0);
                    int b2 = n.volume & 0xff;
                    int b3 = n.timbre & 0xff;
                    hex.append(String.format("%02x%02x%02x%02x", b0, b1, b2, b3));
                }

                String guid = (ins.instrument == null) ? "" : String.valueOf(ins.instrument);

                out.printf(
                    "{\"file\":\"%s\",\"seqUID\":%d,\"seqName\":\"%s\",\"tempo\":%s,\"swing\":%s,"
                    + "\"echoFeedback\":%s,\"echoTime\":%s,\"echoMix\":%s,\"reverb\":%d,"
                    + "\"loop\":%b,\"startPoint\":%s,\"numChannels\":%d,\"volumes\":[%s],"
                    + "\"instIdx\":%d,\"boardX\":%s,\"boardY\":%s,\"instRes\":\"%s\","
                    + "\"instName\":\"%s\",\"level\":%s,\"pan\":%s,\"echoSend\":%s,"
                    + "\"reverbSend\":%s,\"loops\":%d,\"key\":%d,\"scale\":%d,"
                    + "\"noteCount\":%d,\"notes\":\"%s\"}%n",
                    esc(file), thing.UID, esc(chip.name == null ? "" : chip.name.trim()),
                    seq.tempo, seq.swing, seq.echoFeedback, seq.echoTime, seq.echoMix,
                    seq.reverbSettings, seq.loop, seq.startPoint, seq.numChannels, vols,
                    idx, c.x, c.y, esc(guid), esc(ins.name),
                    ins.level, ins.pan, ins.echoSend, ins.reverbSend,
                    ins.loops, ins.key, ins.scale, ins.notes.size(), hex);
                idx++;
            }
        }
    }
}
