alter table public.transactions add constraint supported_original_date
  check (original_date between date '0001-01-01' and date '9999-12-31');
alter table public.transactions add constraint supported_override_date
  check (date_override is null or date_override between date '0001-01-01' and date '9999-12-31');
