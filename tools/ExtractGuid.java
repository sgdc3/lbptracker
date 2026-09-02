import cwlib.types.archives.Fart;
import cwlib.types.archives.FileArchive;
import cwlib.types.data.GUID;
import cwlib.types.data.SHA1;
import cwlib.types.databases.FileDB;
import cwlib.types.databases.FileDBRow;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Resolve a GUID through the FileDB and pull its bytes out of the FARC
 * archives. This closes the chain the sequencer uses:
 *
 *   RInstrument.SampleGuids[i] -> FileDB -> path + SHA1 -> FARC -> bytes
 *
 * Usage:
 *   java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> <outdir> <guid|path-substring> ...
 *
 * <gamedir> is the folder holding base_001.farc and friends. Extracted files
 * are named after their path in the database.
 */
public class ExtractGuid {

    public static void main(String[] args) throws Exception {
        if (args.length < 4) {
            System.out.println(
                "ExtractGuid <orbisguids.map> <gamedir> <outdir> <guid|substring> ...");
            return;
        }

        FileDB db = new FileDB(args[0]);
        File gameDir = new File(args[1]);
        File outDir = new File(args[2]);
        outDir.mkdirs();

        List<Fart> archives = new ArrayList<>();
        File[] farcs = gameDir.listFiles((d, n) -> n.toLowerCase().endsWith(".farc"));
        if (farcs != null) {
            for (File farc : farcs) {
                try {
                    FileArchive archive = new FileArchive(farc);
                    archives.add(archive);
                    System.out.printf("opened %-24s %d entries%n",
                        farc.getName(), archive.getEntryCount());
                } catch (Throwable t) {
                    System.err.println("could not open " + farc.getName() + ": " + t);
                }
            }
        }

        java.util.Map<String, String> claimed = new java.util.HashMap<>();
        for (int i = 3; i < args.length; ++i) {
            String query = args[i];
            List<FileDBRow> rows = new ArrayList<>();
            if (query.matches("\\d+")) {
                FileDBRow row = db.get(new GUID(Long.parseLong(query)));
                if (row != null) rows.add(row);
            } else {
                for (FileDBRow row : db) {
                    if (row.getPath() != null
                        && row.getPath().toLowerCase().contains(query.toLowerCase())) {
                        rows.add(row);
                    }
                }
            }
            if (rows.isEmpty()) {
                System.out.println("no database entry for " + query);
                continue;
            }

            for (FileDBRow row : rows) {
                SHA1 sha1 = row.getSHA1();
                byte[] data = null;
                String from = null;
                for (Fart archive : archives) {
                    if (archive.exists(sha1)) {
                        data = archive.extract(sha1);
                        from = archive.getFile().getName();
                        break;
                    }
                }
                if (data == null) {
                    System.out.printf("MISSING  g%-10s %s (sha1 %s in no archive)%n",
                        row.getGUID(), row.getPath(), sha1);
                    continue;
                }
                String name = row.getPath().replaceAll(".*[/\\\\]", "");
                // ⚠️ Two GUIDs can share a basename, and this used to let the
                // second silently overwrite the first while the manifest listed
                // both pointing at the one survivor. `audio/music/samples` has
                // exactly one such pair -- a_kit_1's kick (g129030) and
                // baiyon_drums_1's (g148304), both `kick.smp` -- so one of the
                // two kits played the other kit's kick, and it took a recording
                // of the game to notice. Disambiguate rather than clobber.
                String guid = row.getGUID().toString().replaceAll("[^0-9]", "");
                String claimedBy = claimed.get(name);
                if (claimedBy != null && !claimedBy.equals(guid)) {
                    name = guid + "-" + name;
                    System.out.printf("NAME CLASH  %s also wanted by g%s -> writing %s%n",
                        row.getPath(), claimedBy, name);
                }
                claimed.put(name, guid);
                Path out = outDir.toPath().resolve(name);
                Files.write(out, data);
                manifest.add(String.format(
                    "  {\"guid\": %s, \"file\": \"%s\", \"path\": \"%s\", \"size\": %d}",
                    guid, name,
                    row.getPath().replace("\\", "/"), data.length));
                System.out.printf("g%-10s %-64s %7d bytes from %-20s magic %s%n",
                    row.getGUID(), row.getPath(), data.length, from, magic(data));
            }
        }

        // A manifest so a browser can resolve a GUID without the FileDB, which
        // is 11 MB and needs the FARC reader anyway. Written next to the files.
        if (!manifest.isEmpty()) {
            Path out = outDir.toPath().resolve("manifest.json");
            Files.writeString(out, "[\n" + String.join(",\n", manifest) + "\n]\n");
            System.out.printf("%nwrote %s (%d entries)%n", out, manifest.size());
        }
    }

    private static final List<String> manifest = new ArrayList<>();

    /** First four bytes as printable characters, then as hex -- enough to spot a format. */
    private static String magic(byte[] data) {
        StringBuilder text = new StringBuilder();
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < Math.min(8, data.length); ++i) {
            int b = data[i] & 0xff;
            text.append(b >= 0x20 && b < 0x7f ? (char) b : '.');
            hex.append(String.format("%02x", b));
        }
        return "\"" + text + "\" " + hex;
    }
}
