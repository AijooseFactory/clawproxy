export class ReasoningStreamProcessor {
    private isThinking = false;
    private hasBailed = false;
    private accumulatedReasoning = "";
    private accumulatedContent = "";

    /**
     * Processes a single delta chunk from the AI.
     * Transforms reasoning_content/thinking/thought into <think> tags in the content field.
     * Maps cumulative upstream payloads to incremental downstream deltas.
     */
    processDelta(delta: any): Record<string, any> {
        if (this.hasBailed) return delta;

        // If this is a tool message or has a different role, pass it through but don't update assistant lengths
        if (delta.role && delta.role !== 'assistant') {
            return delta;
        }

        const rawContent = delta.content || "";
        const rawReasoning = delta.reasoning_content || delta.thinking || delta.thought || "";

        // If we see native <think> tag, bail out and act as a pass-through
        if (typeof rawContent === 'string' && rawContent.includes('<think>')) {
            this.hasBailed = true;
            return delta;
        }

        const out = { ...delta };
        // Strip non-standard fields
        delete out.reasoning_content;
        delete out.thinking;
        delete out.thought;

        let incrementalContent = "";

        // 1. Process Reasoning
        if (rawReasoning && typeof rawReasoning === 'string') {
            // Check if this is a cumulative update or a new delta
            const newReasoning = this.getIncremental(rawReasoning, this.accumulatedReasoning);
            if (newReasoning) {
                if (!this.isThinking) {
                    this.isThinking = true;
                    incrementalContent += "<think>";
                }
                incrementalContent += newReasoning;
                this.accumulatedReasoning += newReasoning;
            }
        }

        // 2. Process Content
        if (rawContent && typeof rawContent === 'string') {
            const newContent = this.getIncremental(rawContent, this.accumulatedContent);
            if (newContent) {
                if (this.isThinking) {
                    this.isThinking = false;
                    incrementalContent += "</think>\n\n";
                }
                incrementalContent += newContent;
                this.accumulatedContent += newContent;
            }
        }

        // Only update output if we actually produced incremental text
        if (incrementalContent) {
            out.content = incrementalContent;
        } else {
            // Drop content field if no new data was found
            delete out.content;
        }

        return out;
    }

    private getIncremental(updated: string, existing: string): string {
        if (!updated) return "";
        // If it's a cumulative update (starts with existing)
        if (existing && updated.startsWith(existing)) {
            return updated.slice(existing.length);
        }
        // If it's a delta (doesn't start with existing, or existing is empty)
        // Note: This matches the "GE" -> "GEM" case where it's cumulative.
        // If it were "A" then "B" as deltas, it would just return "B".
        return updated;
    }

    /**
     * For non-streaming responses.
     */
    processFullResponse(content: string, reasoning?: string): string {
        if (!reasoning || !reasoning.trim()) return content;
        if (content.includes('<think>')) return content;
        return `<think>${reasoning}</think>\n\n${content}`;
    }
}
