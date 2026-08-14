import { OutputFilter } from '../src/guardrails/output-filter.js';

describe('OutputFilter', () => {
  let filter: OutputFilter;

  beforeEach(() => {
    filter = new OutputFilter();
  });

  it('passes normal text unchanged', () => {
    const result = filter.check('Your order has been shipped.');
    expect(result.passed).toBe(true);
    expect(result.filtered).toBeUndefined();
  });

  it('masks phone numbers (11 digits starting with 1[3-9])', () => {
    const result = filter.check('Your phone is 13812345678.');
    expect(result.passed).toBe(false);
    expect(result.filtered).toBeDefined();
    expect(result.filtered).not.toContain('13812345678');
  });

  it('masks 18-digit ID numbers', () => {
    // Use an ID number whose inner digits don't start with 1[3-9] to avoid phone regex
    const result = filter.check('ID: 620102200001011234');
    expect(result.passed).toBe(false);
    expect(result.filtered).toBeDefined();
    expect(result.filtered).not.toContain('620102200001011234');
    expect(result.filtered).toContain('******');
  });

  it('masks API keys starting with sk-', () => {
    const result = filter.check('Key: sk-abc123xyz');
    expect(result.passed).toBe(false);
    expect(result.filtered).toBeDefined();
    expect(result.filtered).not.toContain('sk-abc123xyz');
    expect(result.filtered).toContain('sk-****');
  });

  it('masks multiple sensitive patterns in one string', () => {
    const input = 'Phone: 13912345678, ID: 110101199001011234, Key: sk-secret99';
    const result = filter.check(input);

    expect(result.passed).toBe(false);
    expect(result.filtered).toBeDefined();
    expect(result.filtered).not.toContain('13912345678');
    expect(result.filtered).not.toContain('110101199001011234');
    expect(result.filtered).not.toContain('sk-secret99');
  });

  it('does not mask short digit sequences', () => {
    const result = filter.check('Order #12345 is ready.');
    expect(result.passed).toBe(true);
  });
});
