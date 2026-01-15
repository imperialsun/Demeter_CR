import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Switch } from './switch';

describe('Switch', () => {
  it('renders and triggers onCheckedChange when clicked', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={(c) => onChange(c)} />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeTruthy();
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalled();
  });
});
