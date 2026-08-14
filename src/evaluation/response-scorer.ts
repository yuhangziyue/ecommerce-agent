export interface ScoreResult {
  overall: number;
  dimensions: {
    relevance: number;
    helpfulness: number;
    accuracy: number;
  };
}

export class ResponseScorer {
  score(query: string, response: string, toolsUsed: string[]): ScoreResult {
    // Simple heuristic scoring
    let relevance = 0.5;
    let helpfulness = 0.5;
    let accuracy = 0.5;

    if (response.length > 50) helpfulness += 0.2;
    if (toolsUsed.length > 0) accuracy += 0.3;
    if (response.includes('订单') || response.includes('商品')) relevance += 0.2;

    return {
      overall: (relevance + helpfulness + accuracy) / 3,
      dimensions: { relevance, helpfulness, accuracy },
    };
  }
}
