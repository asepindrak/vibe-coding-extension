export interface WriteTarget {
  path: string;
  kind: "file" | "diff";
}

export interface FileBlock {
  path: string;
  content: string;
}

export function createFileBlockRegex(): RegExp {
  return /\[file\s+(?:name|path)=["']?([^"'\s\]]+)["']?(?:\s+type=["'][^"']+["'])?\]([\s\S]*?)(?:\[\s*\/file\s*\]|(?=\[\/?(?:file|diff|writeFile|writeFileVico))|$)/gi;
}

export function createDiffBlockRegex(): RegExp {
  return /\[diff\s+(?:name|path)=["']?([^"'\s\]]+)["']?\]([\s\S]*?)(?:\[\s*\/diff\s*\]|(?=\[\/?(?:file|diff|writeFile|writeFileVico))|$)/gi;
}

export function extractWriteTargets(content: string): WriteTarget[] {
  const regex =
    /\[(file|diff)\s+(?:name|path)=["']?([^"'\s\]]+)["']?(?:\s+type=["'][^"']+["'])?\]/gi;
  const targets: WriteTarget[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(String(content || ""))) !== null) {
    const kind = match[1]?.toLowerCase() === "diff" ? "diff" : "file";
    const path = String(match[2] || "").trim();
    if (!path) continue;
    targets.push({ path, kind });
  }

  return targets;
}

export function extractFileBlocks(content: string): FileBlock[] {
  const regex = createFileBlockRegex();
  const blocks: FileBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(String(content || ""))) !== null) {
    const path = String(match[1] || "").trim();
    if (!path) continue;
    blocks.push({
      path,
      content: String(match[2] || ""),
    });
  }

  return blocks;
}
