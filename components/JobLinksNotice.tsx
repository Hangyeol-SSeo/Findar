"use client";

import { useEffect, useState } from "react";
import { JOB_SOURCE_LABELS, jobSource } from "@/lib/job-source";

interface JobLinkView { seq: string; otherSeq: string; title: string; url: string; reason: string }

// 다른 출처(금투협·채용 사이트·직접 추가)에 같은 공고가 있어 하나로 합친 경우 알려 주고, 잘못 합쳤으면 "중복 아님"으로 푼다.
export default function JobLinksNotice({ seq }: { seq: string }) {
  const [links, setLinks] = useState<JobLinkView[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/jobs/links?seq=${encodeURIComponent(seq)}`, { cache: "no-store", signal: controller.signal })
      .then((r) => r.json())
      .then((data: { links?: JobLinkView[] }) => setLinks(Array.isArray(data.links) ? data.links : []))
      .catch(() => {});
    return () => controller.abort();
  }, [seq]);

  async function separate(link: JobLinkView) {
    const response = await fetch("/api/jobs/links", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seq: link.seq }),
    }).catch(() => null);
    if (!response?.ok) {
      setMessage("연결을 풀지 못했습니다.");
      return;
    }
    const result = await response.json();
    setLinks((prev) => prev.filter((l) => l.seq !== link.seq));
    setMessage(result.stored ? "따로 보이게 했습니다. 공고 목록을 새로 불러오면 나타납니다." : "따로 받아 오도록 했습니다. 다음 공고 새로고침 때 나타납니다.");
  }

  if (links.length === 0 && !message) return null;
  return (
    <div className="mb-5 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
      {links.map((link) => (
        <div key={link.seq} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5">
          <span>{JOB_SOURCE_LABELS[jobSource(link.otherSeq)]}에도 같은 공고가 있어 하나로 보여 줍니다:</span>
          {link.url ? (
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{link.title}</a>
          ) : (
            <span>{link.title}</span>
          )}
          <button type="button" onClick={() => separate(link)} className="ml-auto font-medium text-gray-500 hover:text-gray-800 hover:underline">
            중복 아님
          </button>
        </div>
      ))}
      {message && <p className="py-0.5 text-gray-500">{message}</p>}
    </div>
  );
}
