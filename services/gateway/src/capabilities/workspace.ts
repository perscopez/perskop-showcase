import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../db.js";
import {
  emailConfigured,
  parseMailIndex,
  wantsMailContent,
} from "../email/inbox.js";

export type MailPromptContext = {
  mailFocusKey?: string;
  memory?: MemoryStore;
  userId?: string;
  projectId?: string;
};

function mailDir(config: AppConfig): string {
  return path.join(config.DATA_DIR, "mail");
}

function isMailRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /mail|e-?posta|gmail|inbox|gelen|sprach|gövde|body/i.test(lower) ||
    wantsMailContent(text) ||
    parseMailIndex(text) != null
  );
}

function resolveFocusIndex(
  userPrompt: string,
  ctx: MailPromptContext,
): number | null {
  const parsed = parseMailIndex(userPrompt);
  if (parsed != null) return parsed;
  if (!ctx.mailFocusKey || !ctx.memory) return null;
  if (isMailRelated(userPrompt) || wantsMailContent(userPrompt)) {
    return ctx.memory.getMailFocus(ctx.mailFocusKey);
  }
  return null;
}

/** Sync Gmail + workspace docs so every motor can read /data directly. */
export async function prepareAgentWorkspace(
  config: AppConfig,
  userPrompt: string,
  ctx: MailPromptContext = {},
): Promise<void> {
  const dir = mailDir(config);
  fs.mkdirSync(dir, { recursive: true });

  if (emailConfigured(config) && ctx.memory) {
    const dbEmails = ctx.memory.getEmails(15);
    const enriched: Array<Record<string, unknown>> = [];

    for (const e of dbEmails) {
      try {
        const atts = ctx.memory.getEmailAttachments(e.uid);
        const attachmentMeta = atts.map((a: any) => ({
          filename: a.filename,
          contentType: a.content_type,
          size: a.size,
          path: a.path,
          textPath: a.text_path || undefined,
        }));

        const attDir = path.join(dir, "attachments", String(e.msg_index));
        fs.mkdirSync(attDir, { recursive: true });

        const txtPath = path.join(dir, `${e.msg_index}.txt`);
        const bodyTextContent = e.body_text || "";
        const pdfTextContents = attachmentMeta
          .map((a: any) => {
            if (!a.textPath) return "";
            const abs = path.join(
              dir,
              "attachments",
              String(e.msg_index),
              path.basename(a.textPath),
            );
            try {
              if (fs.existsSync(abs)) {
                return (
                  `\n\n--- Attachment PDF (${a.filename}) ---\n` +
                  fs.readFileSync(abs, "utf8").trim().slice(0, 8000)
                );
              }
              return "";
            } catch {
              return "";
            }
          })
          .join("");

        const bodyLines = [
          `# Mail ${e.msg_index}`,
          `Subject: ${e.subject}`,
          `From: ${e.from_address}`,
          `Date: ${e.date}`,
          `Account: ${config.EMAIL_ADDRESS}`,
          "",
          bodyTextContent,
        ];

        if (attachmentMeta.length) {
          bodyLines.push("", "## Ekler");
          for (const att of attachmentMeta) {
            bodyLines.push(
              `- ${att.filename} (${att.contentType}, ${att.size} bytes) → ${att.path}`,
            );
            if (att.textPath) {
              bodyLines.push(`  PDF metin: ${att.textPath}`);
            }
          }
          if (pdfTextContents) {
            bodyLines.push("", "## PDF İçerikleri", pdfTextContents);
          }
        }

        fs.writeFileSync(txtPath, bodyLines.join("\n"), "utf8");

        enriched.push({
          index: e.msg_index,
          uid: e.uid,
          from: e.from_address,
          subject: e.subject,
          date: e.date,
          seen: e.seen === 1,
          bodyFile: `mail/${e.msg_index}.txt`,
          attachments: attachmentMeta,
        });
      } catch (err: any) {
        console.error(`Error building mail file for ${e.uid}:`, err.message);
        enriched.push({
          index: e.msg_index,
          uid: e.uid,
          from: e.from_address,
          subject: e.subject,
          date: e.date,
          seen: e.seen === 1,
          bodyFile: `mail/${e.msg_index}.txt`,
          attachments: [],
        });
      }
    }

    fs.writeFileSync(
      path.join(dir, "inbox.json"),
      JSON.stringify(enriched, null, 2),
    );

    const focus = resolveFocusIndex(userPrompt, ctx);
    if (focus != null && ctx.mailFocusKey && ctx.memory) {
      ctx.memory.setMailFocus(ctx.mailFocusKey, focus);
      const focusPath = path.join(dir, `${focus}.txt`);
      if (fs.existsSync(focusPath)) {
        fs.copyFileSync(focusPath, path.join(dir, "current.txt"));
      }
    }
  }

  const readme = [
    "# perskop agent workspace (/data)",
    "",
    "Tam yetki modu — shell, dosya, mail erişimi açık.",
    "",
    "## Mail (Gmail Cache)",
    emailConfigured(config)
      ? `- Hesap: ${config.EMAIL_ADDRESS}`
      : "- Mail yapılandırılmamış",
    "- `mail/inbox.json` — son 15 mail listesi",
    "- `mail/N.txt` — N. mailin tam gövdesi (ör. `mail/7.txt`)",
    "- `mail/current.txt` — son konuşulan mail",
    "",
    "## Komut örnekleri",
    "```bash",
    "cat mail/inbox.json",
    "cat mail/7.txt",
    "cat mail/current.txt",
    "ls -la mail/",
    "```",
    "",
    `Son güncelleme: ${new Date().toISOString()}`,
  ].join("\n");
  fs.writeFileSync(
    path.join(config.DATA_DIR, "README.perskop.md"),
    readme,
    "utf8",
  );
}

export function buildAgentPrompt(
  config: AppConfig,
  userPrompt: string,
): string {
  const lines = [
    "[perskop tam yetki — /data workspace. README.perskop.md ve mail/ klasörünü kullan.]",
    `Çalışma dizini: ${config.DATA_DIR}`,
  ];
  if (emailConfigured(config)) {
    lines.push(
      `Gmail (${config.EMAIL_ADDRESS}): mail/inbox.json + mail/N.txt dosyaları güncel.`,
      "Mail sorusunda önce `cat mail/current.txt` veya `cat mail/N.txt` oku.",
    );
  }
  lines.push("---", `Kullanıcı: ${userPrompt}`);
  return lines.join("\n");
}
