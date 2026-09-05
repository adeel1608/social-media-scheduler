const APP_URL_PLACEHOLDER = "__POSTLINE_APP_URL__";

export function injectPublicMetadata(html: string, appUrl: string): string {
  if (!html.includes(APP_URL_PLACEHOLDER)) {
    throw new Error(
      "The web entrypoint is missing its public URL placeholder.",
    );
  }
  return html.replaceAll(APP_URL_PLACEHOLDER, appUrl);
}
