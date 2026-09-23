import { Fragment } from "react";

// Render common research Markdown as React text, never arbitrary HTML.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold text-gray-900">{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline underline-offset-2 break-words">{link[1]}</a>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export default function ResearchContent({ content }: { content: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/) || line.match(/^\*\*([^*]+)\*\*\s*$/);
    if (heading) { blocks.push(<h5 key={i} className="text-base font-semibold text-gray-900 pt-3">{inline(heading[1])}</h5>); i++; continue; }
    if (/^[-*_]{3,}$/.test(line)) { blocks.push(<hr key={i} className="border-gray-100" />); i++; continue; }
    const listPattern = /^(?:[-*•]|\d+[.)])\s+/;
    if (listPattern.test(line)) {
      const start = i;
      const ordered = /^\d/.test(line);
      const items = [];
      while (i < lines.length && listPattern.test(lines[i].trim())) {
        items.push(<li key={i}>{inline(lines[i].trim().replace(listPattern, ""))}</li>); i++;
      }
      blocks.push(ordered ? <ol key={start} start={parseInt(line)} className="list-decimal pl-5 space-y-2">{items}</ol> : <ul key={start} className="list-disc pl-5 space-y-2">{items}</ul>);
      continue;
    }
    const start = i;
    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|[-*•]\s|\d+[.)]\s|\*\*[^*]+\*\*\s*$)/.test(lines[i].trim())) paragraph.push(lines[i++]);
    blocks.push(<p key={start} className="whitespace-pre-wrap">{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="space-y-4 text-[15px] leading-7 text-gray-700 break-words">{blocks}</div>;
}
