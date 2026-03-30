const sequences = new Map();

export const existsSequence = id => sequences.has(id);

export const addSequence = (id, sequence) => {
  if (!existsSequence(id)) sequences.set(id, sequence);
};

export const getSequence = id => sequences.get(id) || null;
