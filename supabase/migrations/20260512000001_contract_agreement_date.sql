-- Customer enrollment PDF: agreement date on contract row (matches portal + generate-enrollment-pdf.py)

alter table public.contracts add column if not exists agreement_date date default current_date;
notify pgrst, 'reload schema';
