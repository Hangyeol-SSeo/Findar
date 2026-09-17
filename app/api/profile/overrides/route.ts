import { readCareerGoals, writeCareerGoals } from "@/lib/profile";

export async function GET() {
  return Response.json({ careerGoals: readCareerGoals() });
}

export async function PUT(request: Request) {
  const { careerGoals } = await request.json();
  if (typeof careerGoals !== "string") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  writeCareerGoals(careerGoals);
  return Response.json({ ok: true });
}
