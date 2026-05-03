function parseImagePaths(frontmatter) {
    const matches = [...frontmatter.matchAll(/^\s+(\d+):\s+"(.+)"$/gm)];
    const imagePaths = {};
    for (const [, order, path] of matches) {
        imagePaths[Number(order)] = path;
    }
    return imagePaths;
}
function parseFragments(markdown, imagePaths) {
    const section = markdown.match(/## Fragments\s+([\s\S]*?)\n---/);
    if (!section)
        return [];
    const fragments = [...section[1].matchAll(/### Fragment\s+(\d+)\s+\*\(([^)]+)\)\*\s+([\s\S]*?)(?=\n### Fragment|\n---|$)/g)];
    return fragments.map((match) => {
        const order = Number(match[1]);
        const logic = match[2].trim();
        const body = match[3].trim();
        const text = body
            .split('\n> **Image prompt:**')[0]
            .trim();
        return {
            order,
            logic,
            text,
            imagePath: imagePaths[order],
        };
    });
}
export function parseDreamMarkdownForViz(markdown) {
    const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch)
        return null;
    const frontmatter = frontmatterMatch[1];
    const get = (key) => (frontmatter.match(new RegExp(`^${key}:\\s+(.+)$`, 'm'))?.[1] ?? '')
        .trim()
        .replace(/^"|"$/g, '');
    const imagePaths = parseImagePaths(frontmatter);
    const wakingLine = (markdown.match(/## Waking Line\s+\*([\s\S]*?)\*/)?.[1] ?? '').trim();
    const record = {
        id: get('id'),
        stage: get('stage'),
        preset: get('preset_at_sleep') || get('preset'),
        dreamedAt: get('dreamed_at') || get('dreamedAt'),
        wakingLine,
        imagePaths,
        fragments: [],
    };
    if (!record.id || !record.stage)
        return null;
    record.fragments = parseFragments(markdown, imagePaths);
    return record;
}
//# sourceMappingURL=dream-viz-parser.js.map