import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../db.js";
import { classifyMail, trackedSenderSource } from "./classification.js";
import { GmailStore } from "./gmailStore.js";
import {
  emailConfigured,
  fetchMessageBody,
  fetchRecentInbox,
  startInboxIdleWatcher,
  type InboxMessage,
} from "./inbox.js";

export function trackedMailSource(from: string): "TU Dortmund" | "Kapitel Zwei" | null {
  return trackedSenderSource(from);
}

export function formatTrackedMailAlert(message: InboxMessage, body: string): string {
  const source = trackedMailSource(message.from) ?? message.from;
  const when = new Date(message.date).toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const preview = body
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  return [
    `📨 ${source}'dan yeni mail geldi`,
    `Konu: ${message.subject}`,
    `Gönderen: ${message.from}`,
    `Saat: ${when}`,
    preview ? `\n${preview}${body.length > 700 ? "…" : ""}` : null,
  ].filter(Boolean).join("\n");
}

type EmailSyncOptions = {
  onTrackedMail?: (message: InboxMessage, body: string) => Promise<void>;
  alertNewerThan?: Date;
};

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "attachment";
}

function extractPdfText(pdfPath: string, txtPath: string): string | null {
  const result = spawnSync("pdftotext", ["-layout", pdfPath, txtPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  try {
    return fs.readFileSync(txtPath, "utf8").trim().slice(0, 12000);
  } catch {
    return null;
  }
}

let isSyncing = false;

export async function runEmailSync(
  config: AppConfig,
  memory: MemoryStore,
  options: EmailSyncOptions = {},
): Promise<{ success: boolean; count?: number; error?: string }> {
  if (isSyncing) {
    return { success: false, error: "Sync already in progress" };
  }
  if (!emailConfigured(config)) {
    return { success: false, error: "Email not configured" };
  }

  isSyncing = true;
  try {
    const dir = path.join(config.DATA_DIR, "mail");
    fs.mkdirSync(dir, { recursive: true });

    // Fetch list of 15 recent emails
    const list = await fetchRecentInbox(config, 15);
    const enrichedList: any[] = [];
    const senderRules = new GmailStore(memory.db).listSenderRules();

    for (const m of list) {
      // Check if we already have this email in SQLite
      const existing = memory.db
        .prepare(`SELECT * FROM emails WHERE uid = ?`)
        .get(String(m.uid)) as any;

      let full;
      if (existing) {
        full = {
          attachments: memory.getEmailAttachments(String(m.uid)),
          bodyText: existing.body_text,
        };
      } else {
        full = await fetchMessageBody(config, m.uid);
      }

      const bodyTextContent = (full as any).bodyText || (full as any).text || "";
      const classification = classifyMail(m, senderRules);
      const source = ["urgent", "priority"].includes(classification.category)
        ? (trackedMailSource(m.from) ?? m.from)
        : null;
      const alertKey = `tracked_mail_alert:${String(m.uid)}`;
      const alertState = memory.db
        .prepare(`SELECT value FROM settings WHERE key = ?`)
        .get(alertKey) as { value: string } | undefined;
      const isAfterWatcherStart = options.alertNewerThan
        ? new Date(m.date).getTime() >= options.alertNewerThan.getTime()
        : false;
      if (
        source &&
        options.onTrackedMail &&
        !alertState &&
        (!existing || isAfterWatcherStart)
      ) {
        memory.db
          .prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, 'pending')`)
          .run(alertKey);
      }
      if (!existing) {
        // The attachments table has a foreign key to emails(uid), so persist
        // the parent row before inserting any attachment metadata.
        memory.saveEmail({
          uid: String(m.uid),
          msg_index: m.index,
          subject: m.subject,
          from_address: m.from,
          date: m.date || new Date().toISOString(),
          seen: m.seen,
          body_text: bodyTextContent,
        });
      }

      const attachmentMeta: Array<{
        filename: string;
        contentType: string;
        size: number;
        path: string;
        textPath?: string;
      }> = [];

      const attDir = path.join(dir, "attachments", String(m.index));
      fs.mkdirSync(attDir, { recursive: true });

      for (const att of (full.attachments as any[])) {
        const filename = safeFilename(att.filename);
        const attPath = path.join(attDir, filename);

        if (att.content && !fs.existsSync(attPath)) {
          fs.writeFileSync(attPath, att.content);
        }

        const rel = `mail/attachments/${m.index}/${filename}`;
        const contentType = att.contentType || att.content_type || "application/octet-stream";
        const meta: any = {
          filename: att.filename,
          contentType,
          size: att.size,
          path: rel,
        };

        if (filename.toLowerCase().endsWith(".pdf")) {
          const txtRel = `mail/attachments/${m.index}/${filename}.txt`;
          const txtAbs = path.join(attDir, `${filename}.txt`);

          if (!fs.existsSync(txtAbs) && fs.existsSync(attPath)) {
            const extracted = extractPdfText(attPath, txtAbs);
            if (extracted) {
              meta.textPath = txtRel;
            }
          } else if (fs.existsSync(txtAbs)) {
            meta.textPath = txtRel;
          }
        }
        attachmentMeta.push(meta);

        if (!existing) {
          memory.saveAttachment({
            email_uid: String(m.uid),
            filename: att.filename,
            content_type: contentType,
            size: att.size,
            path: rel,
            text_path: meta.textPath || null,
          });
        }
      }

      const txtPath = path.join(dir, `${m.index}.txt`);
      const pdfTextContents = attachmentMeta
        .map((a: any) => {
          if (!a.textPath) return "";
          const abs = path.join(
            dir,
            "attachments",
            String(m.index),
            path.basename(a.textPath),
          );
          try {
            return (
              `\n\n--- Attachment PDF (${a.filename}) ---\n` +
              fs.readFileSync(abs, "utf8").trim().slice(0, 8000)
            );
          } catch {
            return "";
          }
        })
        .join("");

      const fullText = bodyTextContent + pdfTextContents;
      fs.writeFileSync(txtPath, fullText);

      enrichedList.push({
        index: m.index,
        uid: String(m.uid),
        subject: m.subject,
        from: m.from,
        date: m.date,
        seen: m.seen,
        attachments: attachmentMeta.map((a: any) => ({
          filename: a.filename,
          size: a.size,
          contentType: a.contentType || a.content_type,
        })),
      });

      const queuedAlert = memory.db
        .prepare(`SELECT value FROM settings WHERE key = ?`)
        .get(alertKey) as { value: string } | undefined;
      if (source && options.onTrackedMail && queuedAlert?.value === "pending") {
        try {
          await options.onTrackedMail(m, bodyTextContent);
          memory.db
            .prepare(`UPDATE settings SET value = 'sent' WHERE key = ?`)
            .run(alertKey);
        } catch (error) {
          console.error(`Tracked mail alert failed for uid ${m.uid}:`, error);
        }
      }
    }

    fs.writeFileSync(
      path.join(dir, "inbox.json"),
      JSON.stringify(enrichedList, null, 2),
    );

    memory.setLastMailSyncTime(new Date().toISOString());
    return { success: true, count: list.length };
  } catch (err: any) {
    console.error("Mail sync error:", err);
    return { success: false, error: err.message };
  } finally {
    isSyncing = false;
  }
}

export function startEmailSyncScheduler(
  config: AppConfig,
  memory: MemoryStore,
  options: Pick<EmailSyncOptions, "onTrackedMail"> = {},
) {
  if (!emailConfigured(config)) return;

  const watcherStartedAt = new Date();
  const liveOptions: EmailSyncOptions = {
    ...options,
    alertNewerThan: watcherStartedAt,
  };

  // Prime the cache without alerting for historical messages, then let IMAP
  // IDLE trigger near-real-time syncs. A 5-minute poll remains as a fallback.
  void runEmailSync(config, memory)
    .then(() => {
      if (!options.onTrackedMail) return;
      startInboxIdleWatcher(
        config,
        async () => {
          const result = await runEmailSync(config, memory, liveOptions);
          if (!result.success && result.error !== "Sync already in progress") {
            console.error("IMAP IDLE mail sync failed:", result.error);
          }
        },
        (error) => console.error("IMAP IDLE watcher error:", error),
      );
    })
    .catch((err) => console.error("Startup mail sync failed:", err));

  // Fallback in case an IMAP IDLE event is missed or the connection reconnects.
  setInterval(() => {
    runEmailSync(config, memory, liveOptions).catch((err) =>
      console.error("Scheduled mail sync failed:", err),
    );
  }, 5 * 60 * 1000);
}
