import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import {
  resolvePublicIdentity,
  type PublicIdentity,
} from "../lib/publicIdentity";

type LegalPageType = "privacy" | "terms" | "deletion";

interface LegalContent {
  title: string;
  intro: ReactNode;
  sections: Array<{ title: string; body: ReactNode }>;
}

function ContactLink({ identity }: { identity: PublicIdentity }) {
  return (
    <a
      className="legal-contact"
      href={`mailto:${identity.contactEmail}`}
      aria-label={`Email ${identity.operatorName} at ${identity.contactEmail}`}
    >
      {identity.contactEmail}
    </a>
  );
}

function privacyContent(identity: PublicIdentity): LegalContent {
  return {
    title: "Privacy Policy",
    intro: (
      <>
        This policy explains how {identity.operatorName} processes information
        in this independently operated Postline installation. Postline is a
        single-owner, self-hosted social-media scheduler. Questions can be sent
        to <ContactLink identity={identity} />.
      </>
    ),
    sections: [
      {
        title: "Information processed",
        body: (
          <ul>
            <li>The owner email and Supabase authentication records.</li>
            <li>
              Connected-account identifiers and encrypted OAuth access and
              refresh credentials.
            </li>
            <li>
              Uploaded media, captions, scheduling metadata, and publishing
              settings selected by the owner.
            </li>
            <li>
              Platform publishing results, available analytics, and security,
              audit, and diagnostic records.
            </li>
          </ul>
        ),
      },
      {
        title: "How information is used",
        body: (
          <p>
            Information is used to authenticate the owner; upload, schedule, and
            publish requested content; display status and analytics; detect
            failures and send failure alerts; and maintain the security and
            reliability of the installation.
          </p>
        ),
      },
      {
        title: "Service providers and platforms",
        body: (
          <p>
            This installation can use Supabase for authentication and data,
            Cloudflare for application delivery and queues, UploadThing for
            media storage, Resend for failure alerts, and Meta/Instagram,
            TikTok, and Google/YouTube for connected-account and publishing
            functions. These providers process information under their own terms
            and policies, potentially in regions outside the owner's location.
          </p>
        ),
      },
      {
        title: "Media visibility",
        body: (
          <p>
            Files stored on UploadThing Free are public-readable by anyone who
            learns their opaque, hard-to-guess URL. Postline normally gives a
            social platform a separate short-lived signed Worker URL, but that
            URL does not make the underlying UploadThing Free file private. Do
            not upload media that cannot safely have this exposure.
          </p>
        ),
      },
      {
        title: "Retention",
        body: (
          <ul>
            <li>
              Successful source media becomes eligible for deletion seven days
              after every selected target succeeds.
            </li>
            <li>
              Failed, incomplete, pending, or ambiguous media is retained until
              the relevant state is resolved or the owner manually deletes it
              through an available deletion workflow.
            </li>
            <li>
              Connected-account credentials remain until the account is
              disconnected, the installation data is deleted, or access is
              revoked.
            </li>
            <li>
              Published social content remains on its platform until it is
              removed there. Infrastructure providers may retain backups and
              logs under their own policies.
            </li>
          </ul>
        ),
      },
      {
        title: "Security",
        body: (
          <p>
            Postline uses owner-only authorization, database Row Level Security,
            encrypted OAuth credentials, server-only secrets, and signed
            delivery URLs. These safeguards reduce risk, but no system or
            transmission method is perfectly secure.
          </p>
        ),
      },
      {
        title: "Owner controls and deletion",
        body: (
          <p>
            The owner can disconnect platform accounts, export installation
            data, and start complete deletion from the application settings. The{" "}
            <a href="/data-deletion">Data Deletion Instructions</a> explain the
            available steps and the limits that apply to already-published
            content.
          </p>
        ),
      },
      {
        title: "Children",
        body: (
          <p>
            This owner-only administration tool is not directed to children and
            is not intended for their use.
          </p>
        ),
      },
      {
        title: "Policy changes",
        body: (
          <p>
            This policy may be updated when the installation, its providers, or
            its data practices change. The date on this page will be updated
            when changes are published.
          </p>
        ),
      },
      {
        title: "Contact",
        body: (
          <p>
            Contact {identity.operatorName} at{" "}
            <ContactLink identity={identity} /> about this policy or an
            owner-data request.
          </p>
        ),
      },
    ],
  };
}

function termsContent(identity: PublicIdentity): LegalContent {
  return {
    title: "Terms of Use",
    intro: (
      <>
        These terms apply to this independently operated Postline installation.
        By using it, the installation owner accepts these terms. Contact{" "}
        <ContactLink identity={identity} /> with questions.
      </>
    ),
    sections: [
      {
        title: "Owner-only, self-hosted service",
        body: (
          <p>
            Postline is designed for one authorized owner, not as a public
            multi-user service. The owner is responsible for the infrastructure,
            configuration, credentials, and people given access to this
            installation.
          </p>
        ),
      },
      {
        title: "Accounts and content",
        body: (
          <p>
            The owner must control, or be authorized to use, every connected
            social account. The owner must also own uploaded content or have all
            permissions needed to store and publish it, including any required
            music, likeness, advertising, and disclosure rights.
          </p>
        ),
      },
      {
        title: "Provider rules",
        body: (
          <p>
            Use must comply with the rules, reviews, audits, quotas, and
            technical requirements of Meta, TikTok, Google, Supabase,
            Cloudflare, UploadThing, Resend, and any other configured provider.
          </p>
        ),
      },
      {
        title: "Prohibited use",
        body: (
          <p>
            Do not use Postline for scraping, credential sharing, unauthorized
            account access, abuse, illegal content, or attempts to bypass
            provider reviews, audits, restrictions, or quotas. Do not interfere
            with the security or operation of the installation or its providers.
          </p>
        ),
      },
      {
        title: "Scheduling and publishing",
        body: (
          <p>
            Scheduled delivery is not guaranteed. Social platforms, networks,
            credentials, queues, and infrastructure can be delayed or fail.
            Postline does not automatically retry a definite failure or an
            ambiguous publishing attempt; the owner must review the result and
            deliberately choose the appropriate next action.
          </p>
        ),
      },
      {
        title: "Open-source licence",
        body: (
          <p>
            The Postline source code is provided under the MIT Licence. That
            licence governs copying, modification, and distribution of the
            software; these terms govern use of this particular installation.
          </p>
        ),
      },
      {
        title: "No warranty",
        body: (
          <p>
            The software and this installation are provided “as is” and “as
            available,” without guarantees that they will be uninterrupted,
            error-free, or suitable for a particular purpose.
          </p>
        ),
      },
      {
        title: "Limitation of liability",
        body: (
          <p>
            To the extent permitted by applicable law, the operator and
            contributors are not responsible for indirect or consequential
            losses arising from use, unavailable providers, publication
            failures, or missed schedules. Nothing in these terms excludes
            responsibility that cannot lawfully be excluded.
          </p>
        ),
      },
      {
        title: "Suspension, disconnection, and deletion",
        body: (
          <p>
            The operator may suspend access to protect the installation or
            comply with provider requirements. The owner can disconnect social
            accounts or delete installation data. Published platform content
            must be managed separately on the relevant platform.
          </p>
        ),
      },
      {
        title: "Changes and contact",
        body: (
          <p>
            These terms may change when the installation or provider
            requirements change. Continued use after updated terms are published
            means the owner accepts them. Contact{" "}
            <ContactLink identity={identity} /> with questions.
          </p>
        ),
      },
    ],
  };
}

function deletionContent(identity: PublicIdentity): LegalContent {
  return {
    title: "Data Deletion Instructions",
    intro: (
      <>
        The installation owner can remove a connected account, retained source
        media, or the complete Postline installation using the steps below. If
        the interface cannot be accessed, contact{" "}
        <ContactLink identity={identity} />.
      </>
    ),
    sections: [
      {
        title: "Disconnect one platform account",
        body: (
          <p>
            Open <strong>Connected accounts</strong>, choose the Instagram,
            TikTok, or YouTube account, and select <strong>Disconnect</strong>.
            Postline requests token revocation where the provider supports it,
            then removes the stored credentials from active use. You can also
            revoke the application's access in the platform's own account
            settings.
          </p>
        ),
      },
      {
        title: "Delete retained media",
        body: (
          <p>
            Source media becomes eligible for automatic deletion seven days
            after every selected target succeeds. Failed, incomplete, pending,
            or ambiguous media is not deleted automatically. Resolve or cancel
            associated publishing work before using an available media-deletion
            control. To remove all retained source media, use the complete
            installation-deletion process below. Contact the operator if a
            deletion control is unavailable.
          </p>
        ),
      },
      {
        title: "Delete the complete Postline installation",
        body: (
          <p>
            Export anything you need, then open <strong>Settings</strong> and
            select <strong>Delete installation data</strong>. Confirm the
            owner-directed deletion when prompted. This removes scheduler
            records and requests deletion of source media held for this
            installation. If the process reports an error, resolve it before
            removing the supporting projects so provider files are not
            abandoned.
          </p>
        ),
      },
      {
        title: "Remove owner-controlled infrastructure copies",
        body: (
          <p>
            After the application deletion completes, deleting the dedicated
            Supabase project and UploadThing application removes the copies
            controlled through those projects. Supabase, UploadThing, and other
            infrastructure providers may retain backups, logs, or deletion
            records under their own policies.
          </p>
        ),
      },
      {
        title: "Already-published social content",
        body: (
          <p>
            Deleting Postline data does not delete content already published on
            Instagram, TikTok, or YouTube. Delete that content through the
            corresponding platform and follow its deletion process if you want
            the platform copy removed.
          </p>
        ),
      },
      {
        title: "Help when the interface is unavailable",
        body: (
          <p>
            Email <ContactLink identity={identity} /> from the owner address,
            identify the affected installation without sending passwords or
            tokens, and describe whether you need an account disconnected,
            retained media reviewed, or the complete installation deleted.
          </p>
        ),
      },
    ],
  };
}

export function LegalPage({ type }: { type: LegalPageType }) {
  const identity = resolvePublicIdentity(import.meta.env);
  const page =
    type === "privacy"
      ? privacyContent(identity)
      : type === "terms"
        ? termsContent(identity)
        : deletionContent(identity);

  return (
    <main className="legal-page">
      <a href="/" className="brand">
        <span className="brand-mark">P</span>
        <span className="brand-word">postline</span>
      </a>
      <article>
        <a href="/" className="back-link">
          <ArrowLeft size={16} /> Back to Postline
        </a>
        <p className="eyebrow">POSTLINE · PUBLIC INFORMATION</p>
        <h1>{page.title}</h1>
        <p className="legal-intro">{page.intro}</p>
        <p className="legal-date">Last updated 4 September 2026</p>
        {page.sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.body}
          </section>
        ))}
      </article>
    </main>
  );
}
