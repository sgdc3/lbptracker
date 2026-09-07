import cwlib.resources.RScript;
import cwlib.resources.RTranslationTable;
import cwlib.structs.script.FunctionDefinitionRow;
import cwlib.structs.script.Instruction;
import cwlib.structs.script.instructions.LoadConstInstruction;
import cwlib.types.SerializedResource;

import java.nio.file.*;
import java.util.*;

/**
 * What a compiled LBP script says, through the game's own translation table.
 *
 * The toolkit parses `.ff` into an `RScript`: a string table, a constant table,
 * and `sharedBytecode` sliced per function by `FunctionDefinitionRow`. A
 * `LoadConstInstructionInt` carries its value **inline** -- not as an index
 * into `constantTableS64`, which is empty in these scripts -- and for a UI
 * string that value is a LAMS key id, so `RTranslationTable.translate` turns
 * the operand into the words a player reads. ⚠️ That inline int is why
 * searching a script's bytes for an id as u32 or as a LEB128 varint finds
 * nothing: it is packed in the instruction word.
 *
 *   java -cp "$JAR;out" ReverbOrder <script.ff> <english.trans> [function-filter]
 *
 * This is how the sequencer's reverb list was read: `AddReverbs__` in
 * `gamedata/scripts/tweaksequencer.ff` appends six translated ids in order,
 * which is the order the game's menu shows and the order `ReverbSetting`
 * indexes (steering/lbp-audio-engine.md). The same walk works on any tweak
 * script whose list is built in bytecode.
 *
 * ⚠️ Needs JDK 21 or 25; the `java` on PATH is 1.8. `lbpres.py --raw` is *not*
 * needed here -- `SerializedResource` decompresses the `.ff` itself.
 */
public class ReverbOrder {
    public static void main(String[] a) throws Exception {
        RScript s = new SerializedResource(Files.readAllBytes(Paths.get(a[0]))).loadResource(RScript.class);
        RTranslationTable lams = new RTranslationTable(Files.readAllBytes(Paths.get(a[1])));
        System.out.println("class " + s.className
            + " | " + s.stringATable.size() + " ascii strings, "
            + s.constantTableS64.size() + " s64 constants, "
            + s.constantTable.size() + " floats, "
            + s.functionDefinitions.size() + " functions, "
            + s.sharedBytecode.size() + " instructions");

        System.out.println("\n-- s64 constants that the translation table knows:");
        for (int i = 0; i < s.constantTableS64.size(); i++) {
            long v = s.constantTableS64.get(i);
            String t = null;
            try { t = lams.translate(v); } catch (Throwable ignored) { }
            if (t != null && !t.isEmpty())
                System.out.printf("   [%3d] 0x%08x  %s%n", i, v, t.length() > 60 ? t.substring(0, 60) : t);
        }

        for (FunctionDefinitionRow f : s.functionDefinitions) {
            String name = s.stringATable.get(f.nameStringIdx);
            if (a.length > 2 && !name.toLowerCase().contains(a[2].toLowerCase())) continue;
            System.out.printf("%n-- %s: bytecode %d..%d%n", name, f.bytecodeBegin, f.bytecodeEnd);
            for (int i = f.bytecodeBegin; i < f.bytecodeEnd && i < s.sharedBytecode.size(); i++) {
                Instruction ins = s.sharedBytecode.get(i);
                String extra = "";
                if (ins instanceof cwlib.structs.script.instructions.LoadConstInstructionInt li) {
                    long v = li.value & 0xffffffffL;
                    String t = null;
                    try { t = lams.translate(v); } catch (Throwable ignored) { }
                    extra = String.format("   value %d (0x%08x)%s", li.value, v, t == null || t.isEmpty() ? "" : "  -> \"" + t + "\"");
                } else if (ins instanceof cwlib.structs.script.instructions.CallInstruction ci) {
                    String fn = ci.call >= 0 && ci.call < s.functionReferences.size()
                        ? String.valueOf(s.functionReferences.get(ci.call).nameStringIdx) : "?";
                    extra = "   call ref " + ci.call;
                }
                if (false && ins instanceof LoadConstInstruction lc) {
                    String kind = ins.getInstructionType().toString();
                    if (kind.contains("INT") || kind.contains("I32") || kind.contains("S64") || kind.contains("LONG")) {
                        if (lc.index >= 0 && lc.index < s.constantTableS64.size()) {
                            long v = s.constantTableS64.get(lc.index);
                            String t = null;
                            try { t = lams.translate(v); } catch (Throwable ignored) { }
                            extra = String.format("   -> 0x%08x %s", v, t == null ? "" : "\"" + t + "\"");
                        }
                    } else if (kind.contains("STRING") || kind.contains("SA") || kind.contains("SW")) {
                        if (lc.index >= 0 && lc.index < s.stringATable.size())
                            extra = "   -> \"" + s.stringATable.get(lc.index) + "\"";
                    }
                }
                System.out.printf("   %4d  %-46s%s%n", i, ins.toString(), extra);
            }
        }
    }
}
