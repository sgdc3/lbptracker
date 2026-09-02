import cwlib.types.databases.FileDB;
import cwlib.types.databases.FileDBRow;
import cwlib.types.data.GUID;

/**
 * Resolve GUIDs against the game's FileDB (`output/orbisguids.map`), which maps
 * GUID -> path + SHA1. The SHA1 then addresses the bytes inside the FARC
 * archives, so this is the first half of the chain that open question 1 is
 * about: RInstrument.SampleGuids -> audio.
 *
 * Build and run. Use the JDK 25 `java`, not whatever is first on PATH -- a
 * Java 8 runtime is installed on this machine and fails with
 * UnsupportedClassVersionError:
 *   "C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot\bin\java"
 *
 *   javac -cp "$JAR" -d out tools/GuidLookup.java
 *   java  -cp "$JAR;out" GuidLookup <orbisguids.map> [guid|substring ...]
 *
 * With no queries it reports how the database breaks down by folder, which is
 * how you find where a resource type actually lives.
 */
public class GuidLookup {

    public static void main(String[] args) {
        if (args.length < 1) {
            System.out.println("GuidLookup <orbisguids.map> [guid|substring ...]");
            return;
        }

        FileDB db = new FileDB(args[0]);
        System.out.printf("%s: %d entries%n%n", args[0], db.getEntryCount());

        if (args.length == 1) {
            summarise(db);
            return;
        }

        for (int i = 1; i < args.length; ++i) {
            String query = args[i];
            System.out.println("=== " + query + " ===");
            if (query.matches("\\d+")) {
                FileDBRow row = db.get(new GUID(Long.parseLong(query)));
                System.out.println(row == null
                    ? "  no entry for that GUID"
                    : String.format("  %s%n    sha1 %s  size %d",
                        row.getPath(), row.getSHA1(), row.getSize()));
            } else {
                int shown = 0;
                for (FileDBRow row : db) {
                    if (row.getPath() == null) continue;
                    if (!row.getPath().toLowerCase().contains(query.toLowerCase())) continue;
                    if (shown < 40) {
                        System.out.printf("  g%-10s %-70s %d bytes%n",
                            row.getGUID(), row.getPath(), row.getSize());
                    }
                    shown++;
                }
                System.out.println("  " + shown + " matches");
            }
            System.out.println();
        }
    }

    /** Entries per top-level folder, with a size total: shows where the bulk is. */
    private static void summarise(FileDB db) {
        java.util.TreeMap<String, long[]> byFolder = new java.util.TreeMap<>();
        for (FileDBRow row : db) {
            String path = row.getPath();
            if (path == null) continue;
            int slash = path.replace('\\', '/').indexOf('/');
            String folder = slash < 0 ? "(root)" : path.substring(0, slash);
            long[] acc = byFolder.computeIfAbsent(folder, k -> new long[2]);
            acc[0] += 1;
            acc[1] += row.getSize();
        }
        System.out.printf("%-32s %8s %14s%n", "folder", "entries", "bytes");
        byFolder.entrySet().stream()
            .sorted((a, b) -> Long.compare(b.getValue()[0], a.getValue()[0]))
            .forEach(e -> System.out.printf("%-32s %8d %14d%n",
                e.getKey(), e.getValue()[0], e.getValue()[1]));
    }
}
