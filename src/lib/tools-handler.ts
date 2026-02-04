import { z } from 'zod';

export function mapSkillToTool(skill: any): any {
    // OpenClaw skills usually have: name, description, schema (zod-like or json schema)
    // We need to convert them to OpenAI Tool format:
    // {
    //   type: "function",
    //   function: {
    //     name: string,
    //     description: string,
    //     parameters: JSONSchema
    //   }
    // }

    // This is a best-effort mapping assuming OpenClaw provides a 'schema' property 
    // that is either a JSON Schema object or needs some conversion.
    // If 'inputSchema' is provided (common in some agent frameworks), usage that.

    const parameters = skill.inputSchema || skill.schema || { type: "object", properties: {} };

    return {
        type: "function",
        function: {
            name: skill.name,
            description: skill.description || "",
            parameters: parameters
        }
    };
}

export function mapSkillsToTools(skills: any[]): any[] {
    return skills.map(mapSkillToTool);
}
