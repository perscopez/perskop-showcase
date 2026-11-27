export type MailCategory = "urgent" | "priority" | "promotion" | "normal";

export type ClassifiableMail = {
  subject: string;
  from: string;
  seen?: boolean;
  snippet?: string;
  labels?: string[];
  headers?: Record<string, string | undefined>;
};

export type SenderRule = {
  pattern: string;
  action: "important" | "promotion" | "normal";
};

export type MailClassification = {
  category: MailCategory;
  score: number;
  hidden: boolean;
  reasons: string[];
};

function senderAddress(from: string): string {
  const bracketed = from.match(/<([^>]+)>/);
  return (bracketed?.[1] ?? from).trim().toLowerCase();
}

function matchesSenderRule(address: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("@")) return address.endsWith(normalized);
  if (!normalized.includes("@")) return address.endsWith(`@${normalized}`);
  return address === normalized;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function trackedSenderSource(from: string): "TU Dortmund" | "Kapitel Zwei" | null {
  const address = senderAddress(from);
  if (address.endsWith("@kapitel-zwei.de")) return "Kapitel Zwei";
  if (address.endsWith("@tu-dortmund.de")) return "TU Dortmund";
  return null;
}

export function classifyMail(
  message: ClassifiableMail,
  senderRules: SenderRule[] = [],
): MailClassification {
  const address = senderAddress(message.from);
  const text = `${message.subject} ${message.from} ${message.snippet ?? ""}`.toLowerCase();
  const labels = new Set((message.labels ?? []).map((label) => label.toUpperCase()));
  const headers = Object.fromEntries(
    Object.entries(message.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const senderRule = senderRules.find((rule) => matchesSenderRule(address, rule.pattern));

  const university =
    address.endsWith("@tu-dortmund.de") ||
    address.endsWith(".edu") ||
    /\b(university|universite|üniversite|hochschule|admission|admissions)\b/i.test(text);
  const languageCourse =
    address.endsWith("@kapitel-zwei.de") ||
    /\b(goethe|sprachschule|language course|dil kursu|almanca|deutsch|intensive german|kurs)\b/i.test(text);
  const visa = /\b(visa|vize|aufenthalt|residence permit)\b/i.test(text);
  const deadline = /\b(deadline|son tarih|frist|due date|tomorrow|yarın)\b/i.test(text);
  const actionRequired = /\b(action required|response required|cevap gerekiyor|yanıt gerekiyor|urgent|acil)\b/i.test(text);
  const application = /\b(application|başvuru|bewerbung|documents?|evrak)\b/i.test(text);
  const appointment = /\b(appointment|randevu|termin)\b/i.test(text);
  const exam = /\b(exam|sınav|prüfung)\b/i.test(text);
  const security = /\b(security alert|güvenlik uyarısı|unusual sign-in|şüpheli giriş)\b/i.test(text);

  const important = university || languageCourse || visa || application || appointment || exam || security;
  const urgent = deadline || actionRequired || security || (visa && appointment);
  const gmailPromotion = labels.has("CATEGORY_PROMOTIONS");
  const listMail = Boolean(headers["list-unsubscribe"]);
  const marketingLanguage = /\b(unsubscribe|abonelikten çık|kampanya|indirim|discount|sale|promo|promotion|newsletter|bülten|reklam|deal|offer|coupon|kupon|last call|don.?t miss|debut|free access|developer tier|survey reminder|outlier|cerebras|docker mcp)\b/i.test(text);
  const automatedSender = /\b(no-reply|noreply|donotreply)@/i.test(address);
  const automaticPromotion = gmailPromotion || listMail || marketingLanguage || (automatedSender && !important && !urgent);

  const reasons = unique([
    university ? "university" : null,
    languageCourse ? "language_course" : null,
    visa ? "visa" : null,
    deadline ? "deadline" : null,
    actionRequired ? "action_required" : null,
    application ? "application" : null,
    appointment ? "appointment" : null,
    exam ? "exam" : null,
    security ? "security" : null,
    gmailPromotion ? "gmail_promotions" : null,
    listMail ? "list_unsubscribe" : null,
    marketingLanguage ? "marketing_language" : null,
    automatedSender && !important && !urgent ? "automated_sender" : null,
    senderRule ? `sender_rule_${senderRule.action}` : null,
  ]);

  let category: MailCategory;
  if (senderRule?.action === "promotion") category = "promotion";
  else if (senderRule?.action === "important") category = "priority";
  else if (senderRule?.action === "normal") category = "normal";
  else if (automaticPromotion && !important && !urgent) category = "promotion";
  else if (urgent) category = "urgent";
  else if (important) category = "priority";
  else category = "normal";

  let score = message.seen === false ? 4 : 0;
  if (category === "urgent") score += 9;
  if (category === "priority") score += 4;
  if (category === "promotion") score -= 20;
  if (senderRule?.action === "important") score += 3;

  return { category, score, hidden: category === "promotion", reasons };
}
