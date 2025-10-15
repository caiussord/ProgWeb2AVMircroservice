// Mocks devem vir ANTES de qualquer importação da sua aplicação para garantir que o mock seja carregado ANTES que o código que você está testando tenha a chance de carregar a versão original.
import { jest } from '@jest/globals';
jest.mock('../src/amqp.js', () => ({
  createChannel: jest.fn().mockResolvedValue({
    ch: {
      publish: jest.fn(), assertQueue: jest.fn(), bindQueue: jest.fn(), consume: jest.fn(),
    },
  }),
}));

import supertest from 'supertest';
import { app } from '../src/index.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const request = supertest(app);

describe('Orders Service API', () => {
  beforeEach(async () => {
    await prisma.order.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deve criar um pedido se o usuário for válido', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    const response = await request.post('/').send({
      userId: 'user-valid-123',
      items: [{ sku: 'BOOK-ABC', qty: 1 }],
      total: 99.99,
    });
    spy.mockRestore();
    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('id');
  });

  it('deve retornar erro 400 se o usuário for inválido', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false });
    const response = await request.post('/').send({
      userId: 'invalid-user',
      items: [{ sku: 'BOOK-XYZ', qty: 1 }],
      total: 50.0,
    });
    spy.mockRestore();
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('usuário inválido');
  });
});