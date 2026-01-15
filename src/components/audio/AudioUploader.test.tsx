import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { AudioUploader } from './AudioUploader';

describe('AudioUploader component', () => {
  it('calls onFileSelected when a file is chosen via input', () => {
    const onFileSelected = vi.fn();
    render(<AudioUploader onFileSelected={onFileSelected} />);

    // In jsdom the file input is rendered but not exposed via a textbox role; query by selector instead
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    const file = new File(['hello'], 'hello.wav', { type: 'audio/wav' });
    // Simulate user selecting a file
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(onFileSelected).toHaveBeenCalledTimes(1);
    expect(onFileSelected).toHaveBeenCalledWith(file);
  });

  it('handles drag and drop file', () => {
    const onFileSelected = vi.fn();
    render(<AudioUploader onFileSelected={onFileSelected} />);

    const dropzone = screen.getByRole('button');

    const file = new File(['x'], 'x.wav', { type: 'audio/wav' });
    // jsdom may not provide DataTransfer constructor; provide a lightweight dataTransfer object
    const dataTransfer = { files: [file], items: { add: () => {} } } as unknown as DataTransfer;

    fireEvent.drop(dropzone, { dataTransfer });

    expect(onFileSelected).toHaveBeenCalledTimes(1);
    // The file is passed as File
    expect(onFileSelected.mock.calls[0][0].name).toBe('x.wav');
  });

  it('does not allow selection when disabled', () => {
    const onFileSelected = vi.fn();
    render(<AudioUploader onFileSelected={onFileSelected} disabled />);

    const dropzone = screen.getByRole('button');
    fireEvent.click(dropzone);
    // We don't open a picker in test env; ensure no file selection occurred
    expect(onFileSelected).not.toHaveBeenCalled();
  });
});
