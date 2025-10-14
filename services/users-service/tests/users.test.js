import request from 'supertest';
import { app, prisma } from '../src/index.js';

beforeAll(async () => {
  // nothing special; prisma is ready against file:./dev.db
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.user.deleteMany();
});

describe('users-service', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'users' });
  });

  test('POST / creates user (201)', async () => {
    const res = await request(app)
      .post('/')
      .send({ name: 'Alice', email: 'alice@example.com' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
  });

  test('POST / duplicate email -> 409', async () => {
    await prisma.user.create({ data: { name: 'Bob', email: 'bob@example.com' } });
    const res = await request(app)
      .post('/')
      .send({ name: 'Bobby', email: 'bob@example.com' });
    expect(res.status).toBe(409);
  });

  test('GET / lists users', async () => {
    await prisma.user.createMany({ data: [
      { name: 'U1', email: 'u1@example.com' },
      { name: 'U2', email: 'u2@example.com' },
    ]});
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  test('GET /:id returns user or 404', async () => {
    const u = await prisma.user.create({ data: { name: 'Carol', email: 'carol@example.com' } });
    const ok = await request(app).get('/' + u.id);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: u.id, email: 'carol@example.com' });

    const nf = await request(app).get('/u_does_not_exist');
    expect(nf.status).toBe(404);
  });
});
