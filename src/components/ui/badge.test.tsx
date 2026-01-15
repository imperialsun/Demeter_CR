import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './badge';

describe('Badge', () => {
  it('renders with text and variant', () => {
    render(<Badge variant="success">OK</Badge>);
    expect(screen.getByText('OK')).toBeTruthy();
  });
});
