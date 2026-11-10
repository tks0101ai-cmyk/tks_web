-- Multiple employees may explicitly have no insurance enrollment.
-- Keep this state distinct from '' (not entered), normalize historic spellings,
-- then rebuild the unique index so its predicate excludes the canonical label.
DROP INDEX IF EXISTS hr_employees_insurance_number_unique;

WITH normalized AS (
  SELECT id,
         replace(
           regexp_replace(
             normalize(lower(trim(insurance_number)), NFD),
             U&'[\0300-\036f]', '', 'g'
           ),
           'đ', 'd'
         ) AS folded
  FROM hr_employees
)
UPDATE hr_employees AS employee
SET insurance_number = 'Không đóng'
FROM normalized
WHERE normalized.id = employee.id
  AND normalized.folded ~ '^(khong|ko|k)\s?dong(\s?(bh|bhxh|bao hiem))?$';

CREATE UNIQUE INDEX hr_employees_insurance_number_unique
  ON hr_employees (insurance_number)
  WHERE insurance_number <> ''
    AND insurance_number <> 'Không đóng'
    AND is_active;
