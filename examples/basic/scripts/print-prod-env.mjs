// Stand-in for a deploy platform's "print production variables as JSON" command.
console.log(JSON.stringify({ DATABASE_URL: 'postgres://app:example-prod-password@db.internal:5432/app' }));
