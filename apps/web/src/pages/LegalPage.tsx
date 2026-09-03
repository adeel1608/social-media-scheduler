import { ArrowLeft } from "lucide-react";

const content = {
  privacy: {
    title: "Privacy Policy template",
    intro:
      "This template describes a self-hosted Postline installation. Customize it for your entity, deployment and jurisdiction before use.",
    sections: [
      [
        "Data processed",
        "Account email, platform OAuth credentials, media selected for publication, post metadata, publish results and available analytics.",
      ],
      [
        "How data is used",
        "Data is used only to authenticate the owner, schedule and publish requested content, display analytics and report failures.",
      ],
      [
        "Storage",
        "Platform credentials are encrypted at application level. Media is private and delivered through short-lived URLs. Successful media becomes eligible for removal after seven days.",
      ],
      [
        "Third parties",
        "Supabase, Cloudflare, Resend, Meta, TikTok and Google process data according to the services configured by the installation owner.",
      ],
    ],
  },
  terms: {
    title: "Terms of Use template",
    intro:
      "A customizable starting point for an independently deployed instance. It is not legal advice.",
    sections: [
      [
        "Permitted use",
        "Use official platform APIs and only accounts you are authorized to control.",
      ],
      [
        "Platform terms",
        "The owner remains responsible for Meta, TikTok, Google and infrastructure-provider terms, quotas and review requirements.",
      ],
      [
        "No warranty",
        "The open-source software is provided under the MIT Licence without warranty.",
      ],
      [
        "Content responsibility",
        "The installation owner is responsible for content, disclosures, audience settings and applicable law.",
      ],
    ],
  },
  deletion: {
    title: "Data Deletion Instructions",
    intro:
      "Use these steps to remove a connected platform account or the complete scheduler installation.",
    sections: [
      [
        "Disconnect one platform",
        "Open Connected accounts, choose the account and disconnect it. Postline requests token revocation where supported, then removes stored credentials.",
      ],
      [
        "Delete retained media",
        "Open Needs attention and delete media associated with failed or review-required posts after resolving any ambiguity.",
      ],
      [
        "Delete the installation",
        "Export anything you need, then use Settings → Delete installation data. Remove the Supabase project and R2 bucket if you want infrastructure-level deletion.",
      ],
      [
        "Platform content",
        "Deleting Postline data does not delete content already published to a social platform. Delete that content on the platform if required.",
      ],
    ],
  },
} as const;

export function LegalPage({ type }: { type: keyof typeof content }) {
  const page = content[type];
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
        <p className="eyebrow">CUSTOMIZABLE TEMPLATE · NOT LEGAL ADVICE</p>
        <h1>{page.title}</h1>
        <p className="legal-intro">{page.intro}</p>
        <p className="legal-date">Last updated 3 September 2026</p>
        {page.sections.map(([title, body]) => (
          <section key={title}>
            <h2>{title}</h2>
            <p>{body}</p>
          </section>
        ))}
      </article>
    </main>
  );
}
