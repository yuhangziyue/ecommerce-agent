import { Message } from '../core/types.js';

export class ContextManager {
  private maxMessages: number;

  constructor(maxMessages: number = 20) {
    this.maxMessages = maxMessages;
  }

  /** Trim messages to fit within context window, keeping system message and recent messages */
  trimMessages(messages: Message[]): Message[] {
    if (messages.length <= this.maxMessages) {
      return messages;
    }

    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const recentMessages = nonSystemMessages.slice(-this.maxMessages + systemMessages.length);

    return [...systemMessages, ...recentMessages];
  }
}
