import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";

const WEBHOOK_SECRET = Deno.env.get("FEEDBACK_WEBHOOK_SECRET")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface FeedbackRecord {
  id: string;
  user_id: string;
  user_email: string;
  type: "bug" | "feedback";
  title: string;
  description: string;
  system_info: {
    appVersion: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    electronVersion: string;
    osVersion: string;
  } | null;
  log_file_path: string | null;
  screenshot_paths: string[] | null;
  app_version: string | null;
  platform: string | null;
  status: string;
  created_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    console.error("Invalid webhook secret");
    return new Response("Unauthorized", { status: 401 });
  }

  let record: FeedbackRecord;
  try {
    const body = await req.json();
    record = body.record;
    if (!record) {
      throw new Error("No record in body");
    }
  } catch (err) {
    console.error("Failed to parse request body:", err);
    return new Response("Bad request", { status: 400 });
  }

  console.log(`Processing feedback ${record.id} (${record.type}): ${record.title}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const zip = new JSZip();
  let hasAttachments = false;

  // Download log file
  if (record.log_file_path) {
    try {
      const { data, error } = await supabase.storage
        .from("feedback-logs")
        .download(record.log_file_path);
      if (error) {
        console.warn("Failed to download log file:", error.message);
      } else if (data) {
        const buffer = await data.arrayBuffer();
        zip.file("logs.txt", buffer);
        hasAttachments = true;
        console.log("Added log file to zip");
      }
    } catch (err) {
      console.warn("Error downloading log file:", err);
    }
  }

  // Download screenshots
  if (record.screenshot_paths && record.screenshot_paths.length > 0) {
    for (let i = 0; i < record.screenshot_paths.length; i++) {
      const screenshotPath = record.screenshot_paths[i];
      try {
        const { data, error } = await supabase.storage
          .from("feedback-logs")
          .download(screenshotPath);
        if (error) {
          console.warn(`Failed to download screenshot ${i}:`, error.message);
          continue;
        }
        if (data) {
          const ext = screenshotPath.split(".").pop() || "png";
          const buffer = await data.arrayBuffer();
          zip.file(`screenshot-${i}.${ext}`, buffer);
          hasAttachments = true;
          console.log(`Added screenshot-${i}.${ext} to zip`);
        }
      } catch (err) {
        console.warn(`Error downloading screenshot ${i}:`, err);
      }
    }
  }

  // Generate zip as base64 directly from JSZip
  let zipBase64: string | null = null;
  if (hasAttachments) {
    zipBase64 = await zip.generateAsync({ type: "base64" });
    console.log(`Zip generated, base64 length: ${zipBase64.length}`);
  }

  // Format email
  const isBug = record.type === "bug";
  const subjectPrefix = isBug ? "[Conduit Bug]" : "[Conduit Feedback]";
  const subject = `${subjectPrefix} ${record.title}`;

  const createdAt = new Date(record.created_at).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  let systemInfoHtml = "";
  if (isBug && record.system_info) {
    const si = record.system_info;
    systemInfoHtml = `
    <tr><td colspan="2" style="padding:12px 0 4px 0;font-weight:bold;border-bottom:1px solid #ddd;">System Info</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">App Version</td><td style="padding:4px 0;">Conduit v${si.appVersion}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Platform</td><td style="padding:4px 0;">${si.platform} (${si.arch})</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">OS</td><td style="padding:4px 0;">${si.osVersion}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Electron</td><td style="padding:4px 0;">${si.electronVersion}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Node</td><td style="padding:4px 0;">${si.nodeVersion}</td></tr>`;
  }

  let attachmentSummary = "None";
  if (hasAttachments) {
    const parts: string[] = [];
    if (record.screenshot_paths && record.screenshot_paths.length > 0) {
      parts.push(`${record.screenshot_paths.length} screenshot(s)`);
    }
    if (record.log_file_path) {
      parts.push("1 log file");
    }
    attachmentSummary = `${parts.join(", ")} — see attached zip`;
  }

  const htmlBody = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
    <h2 style="margin:0 0 16px 0;color:#1a1a1a;">${subjectPrefix} ${escapeHtml(record.title)}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;width:100px;">Type</td><td style="padding:4px 0;">${isBug ? "Bug Report" : "Feedback"}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">User</td><td style="padding:4px 0;">${escapeHtml(record.user_email)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Platform</td><td style="padding:4px 0;">${escapeHtml(record.platform || "unknown")}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">App Version</td><td style="padding:4px 0;">${escapeHtml(record.app_version || "unknown")}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Submitted</td><td style="padding:4px 0;">${createdAt}</td></tr>
      <tr><td colspan="2" style="padding:12px 0 4px 0;font-weight:bold;border-bottom:1px solid #ddd;">Description</td></tr>
      <tr><td colspan="2" style="padding:8px 0;white-space:pre-wrap;">${escapeHtml(record.description)}</td></tr>
      ${systemInfoHtml}
      <tr><td colspan="2" style="padding:12px 0 4px 0;font-weight:bold;border-bottom:1px solid #ddd;">Attachments</td></tr>
      <tr><td colspan="2" style="padding:8px 0;">${attachmentSummary}</td></tr>
    </table>
    <p style="margin-top:24px;font-size:12px;color:#999;">Feedback ID: ${record.id}</p>
  </div>`;

  const emailPayload: Record<string, unknown> = {
    from: "Conduit Bug Reports <bugs@conduitdesktop.com>",
    to: ["Conduit Support <support@conduitdesktop.com>"],
    subject,
    html: htmlBody,
  };

  if (zipBase64) {
    const shortId = record.id.split("-")[0];
    emailPayload.attachments = [
      {
        filename: `feedback-${shortId}.zip`,
        content: zipBase64,
      },
    ];
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(emailPayload),
    });

    if (!resp.ok) {
      const details = await resp.text();
      console.error("Resend error:", resp.status, details);
      return new Response(JSON.stringify({ error: "Email send failed", details }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`Email sent successfully for feedback ${record.id}`);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Failed to send email:", err);
    return new Response(JSON.stringify({ error: "Email send failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
