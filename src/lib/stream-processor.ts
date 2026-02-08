
export class ReasoningStreamProcessor {
    private isThinking = false;
    private hasBailed = false;

    /**
     * Processes a single delta chunk from the AI.
     * Transforms reasoning_content/thinking/thought into <think> tags in the content field.
     */
    processDelta(delta: any): Record<string, any> {
        if (this.hasBailed) return delta;

        const content = delta.content || "";
        const reasoning = delta.reasoning_content || delta.thinking || delta.thought;

        // If we see native <think> tag, bail out and act as a pass-through
        if (content.includes('<think>')) {
            this.hasBailed = true;
            return delta;
        }

        const out = { ...delta };
        // Strip non-standard fields
        delete out.reasoning_content;
        delete out.thinking;
        delete out.thought;

        let processedContent = "";

        if (reasoning) {
            if (!this.isThinking) {
                this.isThinking = true;
                processedContent += "<think>";
            }
            processedContent += reasoning;
        }

        if (content) {
            if (this.isThinking) {
                this.isThinking = false;
                processedContent += "</think>\n\n";
            }
            processedContent += content;
        }

        // Only update content if we actually produced something or if it's explicitly provided as empty
        if (reasoning || content) {
            out.content = processedContent;
        }

        return out;
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
