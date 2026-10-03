/**
 * Load-test seed (spec §15): 200 employees and three years of punches.
 * Run on top of the development seed, against a separate database:
 *
 *   DATABASE_URL=postgresql://…/ajpwer_load npm run db:deploy --workspace=@ajpwer/backend
 *   DATABASE_URL=postgresql://…/ajpwer_load npm run db:seed
 *   DATABASE_URL=postgresql://…/ajpwer_load npm run db:seed:load
 *   DATABASE_URL=postgresql://…/ajpwer_load npm run test:load --workspace=@ajpwer/backend
 *
 * Punches are generated set-based in SQL (four a day: in, lunch out, lunch in,
 * out; about 5% absent days), which is ~750,000 rows for 200 people over three years.
 */
import { addDays, istDate } from '@ajpwer/shared';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TARGET = Number(process.env.LOAD_EMPLOYEES ?? 200);
const YEARS = Number(process.env.LOAD_YEARS ?? 3);

async function main() {
  const today = istDate(new Date());
  const start = addDays(today, -Math.round(365.25 * YEARS));
  const group = await prisma.payGroup.findFirst({ where: { name: 'Site workforce' } });
  const depts = await prisma.department.findMany();
  if (!group || !depts.length) throw new Error('Run the development seed first (npm run db:seed).');
  const existing = await prisma.employee.count();
  const toAdd = Math.max(0, TARGET - existing);
  console.log(`Adding ${toAdd} employees (have ${existing}) and punches from ${start} to ${today}…`);

  // Employees, statutory, identity and salary — set-based.
  await prisma.$executeRawUnsafe(`
    WITH n AS (SELECT g AS i FROM generate_series(1, ${toAdd}) g),
    ins AS (
      INSERT INTO employee (id, code, name, gender, phone, department_id, designation, pay_group_id, status, joined_on, activated_at)
      SELECT gen_random_uuid(), 'LT' || lpad(i::text, 4, '0'), 'Load Worker ' || i,
             CASE WHEN i % 7 = 0 THEN 'FEMALE'::"Gender" ELSE 'MALE'::"Gender" END,
             '98' || lpad((10000000 + i)::text, 8, '0'),
             (SELECT id FROM department ORDER BY name OFFSET (i % ${depts.length}) LIMIT 1),
             (ARRAY['Lineman','Electrician','Fitter','Mason','Rigger','Helper'])[1 + i % 6],
             '${group.id}'::uuid, 'ACTIVE', DATE '${start}' + (i % 400), now()
      FROM n RETURNING id, joined_on
    ),
    st AS (INSERT INTO employee_statutory (id, employee_id, pt_state, esi_enabled) SELECT gen_random_uuid(), id, 'Andhra Pradesh', true FROM ins RETURNING employee_id),
    idn AS (INSERT INTO employee_identity (id, employee_id, uan, bank_last4, bank_ifsc, bank_account_enc) SELECT gen_random_uuid(), id, '1' || lpad((abs(hashtext(id::text)) % 100000000000)::text, 11, '0'), '1234', 'SBIN0001234', NULL FROM ins RETURNING employee_id)
    INSERT INTO employee_salary (id, employee_id, valid_from, mode, amount, monthly_gross, structure_id, reason, created_by)
    SELECT gen_random_uuid(), id, joined_on, 'GROSS', 1600000 + (abs(hashtext(id::text)) % 80) * 25000, 1600000 + (abs(hashtext(id::text)) % 80) * 25000, '${group.structure_id}'::uuid, 'Load test', 'seed-load'
    FROM ins`);

  // Punches — four a day on working days, skipping Sundays and ~5% of days.
  const sites = await prisma.site.findMany({ where: { code: { not: 'HO' } }, select: { id: true } });
  const siteArray = `(ARRAY[${sites.map((s) => `'${s.id}'::uuid`).join(',')}])`;
  const t0 = Date.now();
  const inserted = await prisma.$executeRawUnsafe(`
    INSERT INTO punch (id, employee_id, punched_at, client_punched_at, work_date, direction, site_id, method, match_score, distance_m, device_id)
    SELECT gen_random_uuid(), e.id, ts, ts, d::date, dir::"PunchDirection", ${siteArray}[1 + abs(hashtext(e.id::text)) % ${sites.length}], 'FACE', 0.8, 40, 'load'
    FROM employee e
    CROSS JOIN LATERAL generate_series(GREATEST(e.joined_on, DATE '${start}'), DATE '${addDays(today, -1)}', interval '1 day') d
    CROSS JOIN LATERAL (VALUES
      ('IN',  (d::date + time '08:40' + (abs(hashtext(e.id::text || d::text)) % 40) * interval '1 minute') AT TIME ZONE 'Asia/Kolkata'),
      ('OUT', (d::date + time '13:00') AT TIME ZONE 'Asia/Kolkata'),
      ('IN',  (d::date + time '13:40') AT TIME ZONE 'Asia/Kolkata'),
      ('OUT', (d::date + time '17:30' + (abs(hashtext(d::text || e.id::text)) % 90) * interval '1 minute') AT TIME ZONE 'Asia/Kolkata')
    ) AS p(dir, ts)
    WHERE e.code LIKE 'LT%'
      AND extract(dow FROM d) <> 0
      AND abs(hashtext(e.code || d::text)) % 100 >= 5
    ON CONFLICT DO NOTHING`);
  console.log(`Inserted ${inserted.toLocaleString('en-IN')} punches in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  await prisma.$executeRawUnsafe('ANALYZE');
  const total = await prisma.punch.count();
  console.log(`Punch table now holds ${total.toLocaleString('en-IN')} rows; ${await prisma.employee.count()} employees.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
