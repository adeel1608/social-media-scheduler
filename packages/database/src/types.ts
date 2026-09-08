import type { Platform, TargetStatus } from "@scheduler/shared";

export interface Database {
  public: {
    Tables: {
      installation_settings: {
        Row: {
          id: string;
          owner_id: string;
          owner_email: string;
          timezone: string;
          configured_services: Record<string, boolean>;
          created_at: string;
          updated_at: string;
        };
      };
      connected_accounts: {
        Row: {
          id: string;
          owner_id: string;
          platform: Platform;
          authorization_context: "owner" | "meta_review";
          authorization_generation: string | null;
          remote_account_id: string;
          username: string | null;
          encrypted_access_token: string;
          access_token_nonce: string;
          encrypted_refresh_token: string | null;
          refresh_token_nonce: string | null;
          encryption_key_version: string;
          scopes: string[];
          token_expires_at: string | null;
          connection_status: string;
          approval_state: string;
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
      };
      account_disconnect_transactions: {
        Row: {
          account_id: string;
          owner_id: string;
          operation_id: string;
          state:
            | "prepared"
            | "revocation_started"
            | "provider_revoked"
            | "revocation_uncertain"
            | "completed";
          provider_outcome: "confirmed" | "uncertain" | null;
          expires_at: string;
          provider_request_sent_at: string | null;
          provider_result_recorded_at: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      media_assets: {
        Row: {
          id: string;
          owner_id: string;
          authorization_context: "owner" | "meta_review";
          authorization_generation: string | null;
          object_key: string;
          storage_provider: "r2" | "uploadthing";
          provider_file_key: string | null;
          provider_url: string | null;
          original_filename: string;
          mime_type: string;
          size_bytes: number;
          upload_status:
            "pending" | "uploading" | "complete" | "aborted" | "deleted";
          reservation_expires_at: string | null;
          deletion_status: "not_requested" | "pending" | "confirmed" | "failed";
          deletion_attempted_at: string | null;
          provider_deleted_at: string | null;
          deletion_last_error: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      posts: {
        Row: {
          id: string;
          owner_id: string;
          authorization_context: "owner" | "meta_review";
          authorization_generation: string | null;
          title: string;
          base_caption: string;
          timezone: string;
          scheduled_at_utc: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      post_targets: {
        Row: {
          id: string;
          owner_id: string;
          post_id: string;
          connected_account_id: string | null;
          platform: Platform;
          authorization_context: "owner" | "meta_review";
          authorization_generation: string | null;
          status: TargetStatus;
          metadata: Record<string, unknown>;
          selected_media_ids: string[];
          scheduled_at_utc: string;
          idempotency_key: string;
          lease_owner: string | null;
          lease_expires_at: string | null;
          publish_request_sent_at: string | null;
          remote_content_id: string | null;
          remote_url: string | null;
          last_error_code: string | null;
          last_error_message: string | null;
          published_at: string | null;
          created_at: string;
          updated_at: string;
        };
      };
      analytics_snapshots: {
        Row: {
          id: string;
          owner_id: string;
          post_target_id: string | null;
          connected_account_id: string;
          platform: Platform;
          authorization_generation: string | null;
          captured_at: string;
          period_start: string | null;
          period_end: string | null;
          normalized_metrics: Record<string, unknown>;
          raw_metrics: Record<string, unknown>;
          unavailable_metrics: string[];
        };
      };
    };
  };
}

export type QueueCursor = { scheduledAt: string; id: string };

export function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): QueueCursor {
  const parsed = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  ) as QueueCursor;
  if (!parsed.id || !parsed.scheduledAt)
    throw new Error("Invalid queue cursor");
  return parsed;
}
