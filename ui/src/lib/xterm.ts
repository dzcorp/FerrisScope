// xterm and its addons (~375 KB) load on the first terminal, not at startup.
export async function loadXterm() {
  const [xterm, fit, links, search] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/addon-search"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return {
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    WebLinksAddon: links.WebLinksAddon,
    SearchAddon: search.SearchAddon,
  };
}
