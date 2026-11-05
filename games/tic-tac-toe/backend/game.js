export const MARKS = Object.freeze(['X', 'O']);

export function createBoard() {
  return Array(9).fill(null);
}

export function evaluateBoard(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const line of lines) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { status: 'won', winner: board[a], winningLine: line };
    }
  }
  return board.every(Boolean)
    ? { status: 'draw', winner: null, winningLine: [] }
    : { status: 'playing', winner: null, winningLine: [] };
}

export function placeMark(board, row, col, mark) {
  if (!Number.isInteger(row) || row < 0 || row > 2 || !Number.isInteger(col) || col < 0 || col > 2) {
    throw new RangeError('row and col must be integers from 0 to 2.');
  }
  const index = row * 3 + col;
  if (board[index]) throw new Error('That square is already occupied.');
  board[index] = mark;
  return evaluateBoard(board);
}
