import { redirect } from "next/navigation";

// Books merged into My money. Old links keep working.
export default function Books() {
  redirect("/me#desk");
}
