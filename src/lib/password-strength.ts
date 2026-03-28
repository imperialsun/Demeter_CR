export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;

export type PasswordStrength = {
  score: PasswordStrengthScore;
  label: string;
  hint: string;
};

const LEVELS: Record<PasswordStrengthScore, Omit<PasswordStrength, "score">> = {
  0: {
    label: "Vide",
    hint: "Saisissez un mot de passe.",
  },
  1: {
    label: "Faible",
    hint: "Ajoutez de la longueur et des caractères variés.",
  },
  2: {
    label: "Moyen",
    hint: "Visez au moins 8 caractères avec plusieurs types de caractères.",
  },
  3: {
    label: "Fort",
    hint: "Bonne base. Ajoutez encore un peu de variété.",
  },
  4: {
    label: "Très fort",
    hint: "Niveau élevé.",
  },
};

export function getPasswordStrength(password: string): PasswordStrength {
  const normalized = password.trim();
  if (!normalized) {
    return {
      score: 0,
      ...LEVELS[0],
    };
  }

  const classCount = countCharacterClasses(normalized);
  let score: PasswordStrengthScore = 1;

  if (normalized.length >= 8) {
    score = Math.min(4, score + 1) as PasswordStrengthScore;
  }
  if (normalized.length >= 12) {
    score = Math.min(4, score + 1) as PasswordStrengthScore;
  }
  if (classCount >= 3) {
    score = Math.min(4, score + 1) as PasswordStrengthScore;
  }
  if (classCount === 4 && normalized.length >= 14) {
    score = Math.min(4, score + 1) as PasswordStrengthScore;
  }

  return {
    score,
    ...LEVELS[score],
  };
}

function countCharacterClasses(password: string) {
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  return classes.filter(Boolean).length;
}
