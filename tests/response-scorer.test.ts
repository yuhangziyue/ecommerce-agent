import { describe, it, expect } from 'vitest';
import { ResponseScorer } from '../src/evaluation/response-scorer.js';

describe('ResponseScorer', () => {
  const scorer = new ResponseScorer();

  it('returns base scores of 0.5 for a short response with no tools and no keywords', () => {
    const result = scorer.score('hi', 'hello', []);
    expect(result.dimensions.relevance).toBe(0.5);
    expect(result.dimensions.helpfulness).toBe(0.5);
    expect(result.dimensions.accuracy).toBe(0.5);
    expect(result.overall).toBeCloseTo(0.5);
  });

  it('boosts helpfulness by 0.2 for responses longer than 50 chars', () => {
    const longResponse = 'a'.repeat(51);
    const result = scorer.score('query', longResponse, []);
    expect(result.dimensions.helpfulness).toBeCloseTo(0.7);
  });

  it('does not boost helpfulness for responses of exactly 50 chars', () => {
    const response = 'a'.repeat(50);
    const result = scorer.score('query', response, []);
    expect(result.dimensions.helpfulness).toBe(0.5);
  });

  it('boosts accuracy by 0.3 when tools are used', () => {
    const result = scorer.score('query', 'short', ['search']);
    expect(result.dimensions.accuracy).toBeCloseTo(0.8);
  });

  it('boosts relevance by 0.2 when response contains 订单', () => {
    const result = scorer.score('query', '您的订单已发货', []);
    expect(result.dimensions.relevance).toBeCloseTo(0.7);
  });

  it('boosts relevance by 0.2 when response contains 商品', () => {
    const result = scorer.score('query', '该商品已下架', []);
    expect(result.dimensions.relevance).toBeCloseTo(0.7);
  });

  it('calculates overall as the average of all three dimensions', () => {
    // Long response (>50 chars) with tools and 订单 keyword => all boosts active
    const longResponseWithKeyword = '您的订单' + 'x'.repeat(50);
    const result = scorer.score('query', longResponseWithKeyword, ['orderLookup']);
    expect(result.dimensions.relevance).toBeCloseTo(0.7);
    expect(result.dimensions.helpfulness).toBeCloseTo(0.7);
    expect(result.dimensions.accuracy).toBeCloseTo(0.8);
    expect(result.overall).toBeCloseTo((0.7 + 0.7 + 0.8) / 3);
  });

  it('returns correct structure with overall and dimensions', () => {
    const result = scorer.score('q', 'r', []);
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('dimensions');
    expect(result.dimensions).toHaveProperty('relevance');
    expect(result.dimensions).toHaveProperty('helpfulness');
    expect(result.dimensions).toHaveProperty('accuracy');
  });
});
