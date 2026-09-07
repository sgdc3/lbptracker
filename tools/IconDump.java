import cwlib.resources.RPlan;
import cwlib.resources.RTexture;
import cwlib.types.SerializedResource;
import cwlib.types.archives.Fart;
import cwlib.types.archives.FileArchive;
import cwlib.types.data.GUID;
import cwlib.types.data.ResourceDescriptor;
import cwlib.types.data.SHA1;
import cwlib.types.databases.FileDB;
import cwlib.types.databases.FileDBRow;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.*;
import java.util.*;

/**
 * Each sequencer instrument's own icon, out of the game and into a PNG.
 *
 *   IconDump <orbisguids.map> <gamedir> <outdir>
 *
 * The palette plan that names an instrument also carries its picture:
 * `InventoryItemDetails.icon` is a ResourceDescriptor for a texture, and the
 * toolkit decodes those. Named after the `.rinst` the plan depends on, so the
 * files line up with `fixtures/rinst`.
 */
public class IconDump {
    static FileDB db;
    static List<Fart> archives = new ArrayList<>();

    static byte[] bytes(SHA1 sha1) {
        for (Fart a : archives) if (a.exists(sha1)) return a.extract(sha1);
        return null;
    }

    static byte[] resolve(ResourceDescriptor d) {
        if (d == null) return null;
        if (d.isHash() && d.getSHA1() != null) {
            byte[] b = bytes(d.getSHA1());
            if (b != null) return b;
        }
        if (d.getGUID() != null) {
            FileDBRow row = db.get(d.getGUID());
            if (row != null && row.getSHA1() != null) return bytes(row.getSHA1());
        }
        return null;
    }

    public static void main(String[] a) throws Exception {
        db = new FileDB(a[0]);
        File outDir = new File(a[2]);
        outDir.mkdirs();
        for (File f : new File(a[1]).listFiles((d, n) -> n.toLowerCase().endsWith(".farc")))
            try { archives.add(new FileArchive(f)); } catch (Throwable ignored) { }

        Map<Long, String> rinstNames = new HashMap<>();
        for (String line : Files.readAllLines(Paths.get(a[3]))) {          // guid<TAB>file
            String[] parts = line.split("\t");
            if (parts.length == 2) rinstNames.put(Long.parseLong(parts[0]), parts[1]);
        }

        int wrote = 0, noIcon = 0, failed = 0;
        for (FileDBRow row : db) {
            String path = row.getPath();
            if (path == null || !path.contains("instrument_") || !path.endsWith(".plan")) continue;
            byte[] planBytes = bytes(row.getSHA1());
            if (planBytes == null) continue;
            RPlan plan;
            try { plan = new SerializedResource(planBytes).loadResource(RPlan.class); }
            catch (Throwable t) { continue; }
            if (plan.inventoryData == null || plan.inventoryData.icon == null) { noIcon++; continue; }
            String name = null;
            if (plan.dependencyCache != null)
                for (ResourceDescriptor d : plan.dependencyCache)
                    if (d != null && d.getGUID() != null && rinstNames.containsKey(d.getGUID().getValue()))
                        name = rinstNames.get(d.getGUID().getValue());
            if (name == null) name = path.substring(path.lastIndexOf('/') + 1).replace(".plan", "");
            byte[] tex = resolve(plan.inventoryData.icon);
            if (tex == null) { System.out.println("  no texture for " + name + " (" + plan.inventoryData.icon + ")"); failed++; continue; }
            try {
                BufferedImage img = new RTexture(tex).getImage();
                if (img == null) { failed++; continue; }
                ImageIO.write(img, "png", new File(outDir, name.replace(".rinst", "") + ".png"));
                wrote++;
            } catch (Throwable t) { System.out.println("  " + name + ": " + t); failed++; }
        }
        System.out.printf("%d icons written, %d plans with no icon, %d failed%n", wrote, noIcon, failed);
    }
}
