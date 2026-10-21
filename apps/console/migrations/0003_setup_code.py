from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('console', '0002_system_status_permission'),
    ]

    operations = [
        migrations.CreateModel(
            name='SetupCode',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('code_hash', models.CharField(max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'verbose_name': 'setup code',
                'verbose_name_plural': 'setup codes',
                'default_permissions': (),
            },
        ),
    ]
