
export class StreamProcessor {
    private buffer: string = "";
    private thoughtBlockOpen: boolean = false;

    // Regex for standard xml-style thought tags
    private readonly THOUGHT_START = /<thought>/i;
    private readonly THOUGHT_END = /<\/thought>/i;

    // Configurable thought pattern?
    // For now we assume <thought> tags or we look for specific "type" in payload if the source provides it.

    process(delta: string, payloadType?: string): { content: string | null, thought: string | null } {
        // If the payload explicitly says it's a thought, trust it.
        if (payloadType === 'thought' || payloadType === 'reasoning') {
            return { content: null, thought: delta };
        }

        // Otherwise scan for tags in the text stream
        let content: string | null = null;
        let thought: string | null = null;

        // Simple state machine for streaming tags
        // This is tricky if tags are split across chunks (e.g. "<th" + "ought>")
        // Ideally we buffer a little bit if we see a partial tag.

        // For simplicity and robustness in this proxy, we will filter strictly if we see the tag
        // If we are already in a thought block
        if (this.thoughtBlockOpen) {
            // Check for closing tag
            const closeMatch = delta.match(this.THOUGHT_END);
            if (closeMatch) {
                const parts = delta.split(closeMatch[0]);
                thought = parts[0];
                this.thoughtBlockOpen = false;
                // Remaining part is content
                if (parts.length > 1) {
                    content = parts.slice(1).join('');
                }
            } else {
                thought = delta;
            }
        } else {
            // Check for opening tag
            const startMatch = delta.match(this.THOUGHT_START);
            if (startMatch) {
                const parts = delta.split(startMatch[0]);
                content = parts[0]; // Part before the tag
                this.thoughtBlockOpen = true;

                // Process the rest of the string recursively or just handle simple case
                const remainder = parts.slice(1).join('');
                // If remainder has closing tag immediately
                const closeMatch = remainder.match(this.THOUGHT_END);
                if (closeMatch) {
                    const thoughtParts = remainder.split(closeMatch[0]);
                    thought = thoughtParts[0];
                    this.thoughtBlockOpen = false;
                    if (thoughtParts.length > 1) {
                        content = (content || "") + thoughtParts.slice(1).join('');
                    }
                } else {
                    thought = remainder;
                }
            } else {
                content = delta;
            }
        }

        return { content, thought };
    }

    reset() {
        this.buffer = "";
        this.thoughtBlockOpen = false;
    }
}
