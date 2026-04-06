"use client";

import dynamic from "next/dynamic";

const JobBoard = dynamic(() => import("@/components/JobBoard"), {
  ssr: false,
  loading: () => (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Findar</h1>
      <p className="text-gray-500">금융투자협회 회원사 채용공고를 한눈에</p>
    </div>
  ),
});

export default function Home() {
  return <JobBoard />;
}
