/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithStore } from '@/test/utils';
import UploadPage from './UploadPage';

// Render helper sets store state directly for tests

describe('UploadPage', () => {
  it("shows overall confidence badge and '(estimée)' when source is estimated", () => {
    const storeOverrides = {
      segments: [{ index: 0, text: 'hello', confidence: 0.7, confidenceSource: 'estimated' }],
      showSegments: true,
      transcriptionConfidence: 0.7,
      transcriptionConfidenceSource: 'estimated',
    } as any;

    renderWithStore(<UploadPage />, storeOverrides);

    expect(screen.getByText(/Indice de confiance globale/i)).toBeInTheDocument();
    // transcriptionConfidence 0.7 should render as '70%'
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('(estimée)')).toBeInTheDocument();
  });

  it('hides segments section when there are no segments', () => {
    const storeOverrides = {
      segments: [],
      showSegments: true,
      transcriptionConfidence: null,
    } as any;
    renderWithStore(<UploadPage />, storeOverrides);
    expect(screen.getByText(/Les segments apparaîtront ici/)).toBeInTheDocument();
  });
});
