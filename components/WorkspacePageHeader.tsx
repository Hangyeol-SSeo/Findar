import Link from "next/link";

export default function WorkspacePageHeader({ title, description, current }: {
  title: string;
  description: string;
  current: "profile" | "settings";
}) {
  return (
    <header className="mb-8">
      <Link href="/" className="text-sm text-gray-400 hover:text-gray-600 transition-colors">← 공고 목록</Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-gray-500">{description}</p>
        </div>
        <nav aria-label="자료와 설정" className="flex shrink-0 gap-1 rounded-xl border border-gray-200 bg-white p-1">
          {([{ id: "profile", href: "/profile", label: "내 지원 자료" }, { id: "settings", href: "/settings", label: "설정" }] as const).map(({ id, href, label }) => (
            <Link key={id} href={href} aria-current={current === id ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-sm transition-colors ${current === id ? "bg-blue-50 font-medium text-blue-700" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"}`}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
