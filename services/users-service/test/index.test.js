// Mocks tem que vir primeiro. Mesmo caso do orders-service
import { jest } from '@jest/globals';
jest.mock('../src/amqp.js', () => ({
  createChannel: jest.fn().mockResolvedValue({
    ch: { publish: jest.fn() },
  }),
}));

import supertest from 'supertest';
import { app } from '../src/index.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const request = supertest(app);

describe('Users Service API', () => {
  beforeEach(async () => {
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deve criar um novo usuário com sucesso', async () => {
    const response = await request.post('/').send({ name: 'Caius Sordillo', email: 'caius.sordillo@example.com' });
    expect(response.status).toBe(201);
    expect(response.body.email).toBe('caius.sordillo@example.com');
  });

  it('deve retornar erro 409 para email duplicado', async () => {
    await request.post('/').send({ name: 'Caius', email: 'duplicate@example.com' });
    const response = await request.post('/').send({ name: 'Outro', email: 'duplicate@example.com' });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('email ja existe');
  });
});